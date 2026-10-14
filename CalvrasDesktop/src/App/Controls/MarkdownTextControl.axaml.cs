using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Documents;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Calvras.App.Controls;

public partial class MarkdownTextControl : UserControl
{
    public static readonly StyledProperty<string?> TextProperty =
        AvaloniaProperty.Register<MarkdownTextControl, string?>(nameof(Text));

    public string? Text
    {
        get => GetValue(TextProperty);
        set => SetValue(TextProperty, value);
    }

    private StackPanel? _contentPanel;
    private bool _dirty;
    private readonly DispatcherTimer _debounce = new DispatcherTimer
    {
        Interval = TimeSpan.FromMilliseconds(16)
    };

    // Brush cache
    private static readonly IBrush TextBrush = IBrush.Parse("#E4E4E7")!;
    private static readonly IBrush DimBrush = IBrush.Parse("#71717A")!;
    private static readonly IBrush CodeInlineBg = IBrush.Parse("#1C1C1F")!;
    private static readonly IBrush CodeBlockBg = IBrush.Parse("#0D1117")!;
    private static readonly IBrush CodeBlockBorder = IBrush.Parse("#30363D")!;
    private static readonly IBrush CodeHeaderBg = IBrush.Parse("#161B22")!;
    private static readonly IBrush CodeTextBrush = IBrush.Parse("#C9D1D9")!;
    private static readonly IBrush CodeMetaBrush = IBrush.Parse("#8B949E")!;

    private static readonly FontFamily MonoFamily = new FontFamily("Consolas, Menlo, Monospace");

    // Regex: matches **bold** or `inline code`
    private static readonly Regex InlineRegex =
        new Regex(@"(\*\*(.+?)\*\*|`([^`]+)`)", RegexOptions.Compiled);

    static MarkdownTextControl()
    {
        TextProperty.Changed.AddClassHandler<MarkdownTextControl>((ctrl, _) =>
        {
            ctrl._dirty = true;
            if (!ctrl._debounce.IsEnabled)
                ctrl._debounce.Start();
        });
    }

    public MarkdownTextControl()
    {
        InitializeComponent();
        _contentPanel = this.FindControl<StackPanel>("ContentPanel");
        _debounce.Tick += (_, _) =>
        {
            _debounce.Stop();
            Rebuild();
        };
    }

    // ─── Segment types ───────────────────────────────────────────────────────

    private abstract class Segment { }

    private class ParagraphSegment : Segment
    {
        public string Text { get; init; } = "";
    }

    private class BulletListSegment : Segment
    {
        public List<string> Items { get; } = new();
    }

    private class CodeBlockSegment : Segment
    {
        public string Language { get; init; } = "";
        public string Content { get; init; } = "";
    }

    // ─── Rebuild ─────────────────────────────────────────────────────────────

    private void Rebuild()
    {
        if (_contentPanel == null) return;
        _contentPanel.Children.Clear();

        var text = Text;
        if (string.IsNullOrEmpty(text)) return;

        var segments = Parse(text);

        foreach (var seg in segments)
        {
            switch (seg)
            {
                case ParagraphSegment p:
                    _contentPanel.Children.Add(BuildParagraph(p.Text));
                    break;

                case BulletListSegment bl:
                    var listPanel = new StackPanel { Spacing = 2, Margin = new Thickness(0, 2, 0, 2) };
                    foreach (var item in bl.Items)
                        listPanel.Children.Add(BuildBulletItem(item));
                    _contentPanel.Children.Add(listPanel);
                    break;

                case CodeBlockSegment cb:
                    _contentPanel.Children.Add(BuildCodeBlock(cb.Language, cb.Content));
                    break;
            }
        }
    }

    // ─── Parser ──────────────────────────────────────────────────────────────

    private static List<Segment> Parse(string text)
    {
        var lines = text.Split('\n');
        var segments = new List<Segment>();

        bool inCode = false;
        string codeLang = "";
        var codeLines = new List<string>();
        var paraLines = new List<string>();
        BulletListSegment? currentBullet = null;

        void FlushPara()
        {
            if (paraLines.Count == 0) return;
            var joined = string.Join("\n", paraLines).Trim();
            if (!string.IsNullOrEmpty(joined))
            {
                FlushBullet();
                segments.Add(new ParagraphSegment { Text = joined });
            }
            paraLines.Clear();
        }

        void FlushBullet()
        {
            if (currentBullet == null) return;
            segments.Add(currentBullet);
            currentBullet = null;
        }

        foreach (var rawLine in lines)
        {
            var line = rawLine.TrimEnd();

            if (!inCode && (line.TrimStart().StartsWith("```") || line.TrimStart() == "```"))
            {
                // Opening fence
                FlushPara();
                FlushBullet();
                var fence = line.TrimStart();
                codeLang = fence.Length > 3 ? fence.Substring(3).Trim() : "";
                inCode = true;
                codeLines.Clear();
                continue;
            }

            if (inCode)
            {
                if (line.TrimStart().StartsWith("```"))
                {
                    // Closing fence
                    segments.Add(new CodeBlockSegment
                    {
                        Language = codeLang,
                        Content = string.Join("\n", codeLines)
                    });
                    inCode = false;
                    codeLines.Clear();
                    codeLang = "";
                }
                else
                {
                    codeLines.Add(rawLine.TrimEnd('\r'));
                }
                continue;
            }

            // Bullet item
            var trimmed = line.TrimStart();
            if (trimmed.StartsWith("- ") || trimmed.StartsWith("* "))
            {
                FlushPara();
                var itemText = trimmed.Substring(2);
                if (currentBullet == null) currentBullet = new BulletListSegment();
                currentBullet.Items.Add(itemText);
                continue;
            }

            // Non-bullet line: flush any pending bullet list first
            if (currentBullet != null && !string.IsNullOrWhiteSpace(line))
            {
                FlushBullet();
            }

            // Blank line → paragraph break
            if (string.IsNullOrWhiteSpace(line))
            {
                FlushPara();
            }
            else
            {
                paraLines.Add(line);
            }
        }

        // Flush anything remaining
        if (inCode && codeLines.Count > 0)
        {
            segments.Add(new CodeBlockSegment { Language = codeLang, Content = string.Join("\n", codeLines) });
        }
        FlushPara();
        FlushBullet();

        return segments;
    }

    // ─── Control builders ────────────────────────────────────────────────────

    private Control BuildParagraph(string text)
    {
        var tb = new SelectableTextBlock
        {
            FontSize = 13.5,
            LineHeight = 22,
            TextWrapping = TextWrapping.Wrap,
            Foreground = TextBrush
        };
        foreach (var inline in ParseInlines(text))
            tb.Inlines!.Add(inline);
        return tb;
    }

    private Control BuildBulletItem(string text)
    {
        var bullet = new TextBlock
        {
            Text = "•",
            Foreground = DimBrush,
            Margin = new Thickness(0, 0, 8, 0),
            VerticalAlignment = VerticalAlignment.Top,
            FontSize = 13.5,
            LineHeight = 22
        };

        var content = new SelectableTextBlock
        {
            FontSize = 13.5,
            LineHeight = 22,
            TextWrapping = TextWrapping.Wrap,
            Foreground = TextBrush
        };
        foreach (var inline in ParseInlines(text))
            content.Inlines!.Add(inline);

        return new StackPanel
        {
            Orientation = Avalonia.Layout.Orientation.Horizontal,
            Margin = new Thickness(0, 2),
            Children = { bullet, content }
        };
    }

    private Control BuildCodeBlock(string language, string content)
    {
        // Language label
        var langLabel = new TextBlock
        {
            Text = string.IsNullOrEmpty(language) ? "code" : language,
            Foreground = CodeMetaBrush,
            FontSize = 11,
            VerticalAlignment = VerticalAlignment.Center
        };

        // Copy button
        var copyIcon = new PathIcon
        {
            Width = 12,
            Height = 12,
            Foreground = CodeMetaBrush,
            Data = Geometry.Parse("M4,2 C2.8954305,2 2,2.8954305 2,4 L2,14 C2,15.1045695 2.8954305,16 4,16 L12,16 C13.1045695,16 14,15.1045695 14,14 L14,4 C14,2.8954305 13.1045695,2 12,2 L4,2 Z M4,3 L12,3 C12.5522847,3 13,3.44771525 13,4 L13,14 C13,14.5522847 12.5522847,15 12,15 L4,15 C3.44771525,15 3,14.5522847 3,14 L3,4 C3,3.44771525 3.44771525,3 4,3 Z")
        };

        var copyBtn = new Button
        {
            Content = copyIcon,
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            Padding = new Thickness(4),
            Cursor = new Cursor(StandardCursorType.Hand)
        };
        // Capture content for closure
        var capturedContent = content;
        copyBtn.Click += async (_, _) =>
        {
            var clipboard = TopLevel.GetTopLevel(this)?.Clipboard;
            if (clipboard != null)
                await clipboard.SetTextAsync(capturedContent);
        };

        // Header row
        var headerGrid = new Grid
        {
            ColumnDefinitions = new ColumnDefinitions("*,Auto")
        };
        headerGrid.Children.Add(langLabel);
        Grid.SetColumn(langLabel, 0);
        headerGrid.Children.Add(copyBtn);
        Grid.SetColumn(copyBtn, 1);

        var headerBorder = new Border
        {
            Background = CodeHeaderBg,
            CornerRadius = new CornerRadius(6, 6, 0, 0),
            Padding = new Thickness(10, 6),
            Child = headerGrid
        };

        // Code text
        var codeText = new SelectableTextBlock
        {
            Text = content,
            FontFamily = MonoFamily,
            FontSize = 12,
            Foreground = CodeTextBrush,
            LineHeight = 18,
            TextWrapping = TextWrapping.NoWrap
        };

        var codeScroll = new ScrollViewer
        {
            HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
            VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled,
            Padding = new Thickness(12, 10),
            Content = codeText
        };

        // Outer grid: header + code
        var innerGrid = new Grid
        {
            RowDefinitions = new RowDefinitions("Auto,*")
        };
        innerGrid.Children.Add(headerBorder);
        Grid.SetRow(headerBorder, 0);
        innerGrid.Children.Add(codeScroll);
        Grid.SetRow(codeScroll, 1);

        return new Border
        {
            Background = CodeBlockBg,
            BorderBrush = CodeBlockBorder,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(0),
            Margin = new Thickness(0, 4),
            Child = innerGrid
        };
    }

    // ─── Inline parser ───────────────────────────────────────────────────────

    private IEnumerable<Inline> ParseInlines(string text)
    {
        int lastIndex = 0;
        foreach (Match match in InlineRegex.Matches(text))
        {
            // Plain text before this match
            if (match.Index > lastIndex)
            {
                yield return new Run
                {
                    Text = text.Substring(lastIndex, match.Index - lastIndex),
                    Foreground = TextBrush
                };
            }

            var full = match.Value;
            if (full.StartsWith("**"))
            {
                // Bold
                var inner = match.Groups[2].Value;
                yield return new Run
                {
                    Text = inner,
                    FontWeight = FontWeight.Bold,
                    Foreground = TextBrush
                };
            }
            else if (full.StartsWith("`"))
            {
                // Inline code
                var code = match.Groups[3].Value;
                var codeBorder = new Border
                {
                    Background = CodeInlineBg,
                    CornerRadius = new CornerRadius(3),
                    Padding = new Thickness(3, 0),
                    Child = new TextBlock
                    {
                        Text = code,
                        FontFamily = MonoFamily,
                        FontSize = 12,
                        Foreground = TextBrush
                    }
                };
                yield return new InlineUIContainer { Child = codeBorder };
            }

            lastIndex = match.Index + match.Length;
        }

        // Remaining plain text
        if (lastIndex < text.Length)
        {
            yield return new Run
            {
                Text = text.Substring(lastIndex),
                Foreground = TextBrush
            };
        }
    }
}
