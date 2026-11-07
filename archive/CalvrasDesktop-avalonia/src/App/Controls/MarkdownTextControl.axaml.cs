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
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

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
    private static readonly IBrush TextBrush = new SolidColorBrush(Color.Parse("#E4E4E7"));
    private static readonly IBrush DimBrush = new SolidColorBrush(Color.Parse("#71717A"));
    private static readonly IBrush CodeInlineBg = new SolidColorBrush(Color.Parse("#1E1E22"));
    private static readonly IBrush CodeBlockBg = new SolidColorBrush(Color.Parse("#0D1117"));
    private static readonly IBrush CodeBlockBorder = new SolidColorBrush(Color.Parse("#30363D"));
    private static readonly IBrush CodeHeaderBg = new SolidColorBrush(Color.Parse("#161B22"));
    private static readonly IBrush CodeTextBrush = new SolidColorBrush(Color.Parse("#C9D1D9"));
    private static readonly IBrush CodeMetaBrush = new SolidColorBrush(Color.Parse("#8B949E"));

    private static readonly IBrush TableBorderBrush = new SolidColorBrush(Color.Parse("#2A2A2E"));
    private static readonly IBrush TableHeaderBg = new SolidColorBrush(Color.Parse("#18181C"));
    private static readonly IBrush TableRowBg1 = new SolidColorBrush(Color.Parse("#0E0E10"));
    private static readonly IBrush TableRowBg2 = new SolidColorBrush(Color.Parse("#141416"));

    private static readonly FontFamily MonoFamily = new FontFamily("Consolas, Menlo, Monospace");

    // Regex: matches **bold**, `inline code`, or *italic*
    private static readonly Regex InlineRegex =
        new Regex(@"(\*\*(.+?)\*\*|`([^`]+)`|\*([^*]+)\*)", RegexOptions.Compiled);

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

    private class HeadingSegment : Segment
    {
        public int Level { get; init; } = 1;
        public string Text { get; init; } = "";
    }

    private class BulletListSegment : Segment
    {
        public List<string> Items { get; } = new();
    }

    private class NumberedListSegment : Segment
    {
        public List<string> Items { get; } = new();
    }

    private class TableSegment : Segment
    {
        public List<string> Headers { get; init; } = new();
        public List<List<string>> Rows { get; init; } = new();
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
                case HeadingSegment h:
                    _contentPanel.Children.Add(BuildHeading(h.Level, h.Text));
                    break;

                case ParagraphSegment p:
                    _contentPanel.Children.Add(BuildParagraph(p.Text));
                    break;

                case BulletListSegment bl:
                    var listPanel = new StackPanel { Spacing = 3, Margin = new Thickness(0, 3, 0, 3) };
                    foreach (var item in bl.Items)
                        listPanel.Children.Add(BuildBulletItem(item));
                    _contentPanel.Children.Add(listPanel);
                    break;

                case NumberedListSegment nl:
                    var numPanel = new StackPanel { Spacing = 3, Margin = new Thickness(0, 3, 0, 3) };
                    for (int i = 0; i < nl.Items.Count; i++)
                        numPanel.Children.Add(BuildNumberedItem(i + 1, nl.Items[i]));
                    _contentPanel.Children.Add(numPanel);
                    break;

                case TableSegment tbl:
                    _contentPanel.Children.Add(BuildTable(tbl));
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
        var rawLines = text.Split('\n');
        var segments = new List<Segment>();

        bool inCode = false;
        string codeLang = "";
        var codeLines = new List<string>();
        var paraLines = new List<string>();
        BulletListSegment? currentBullet = null;
        NumberedListSegment? currentNumbered = null;

        void FlushPara()
        {
            if (paraLines.Count == 0) return;
            var joined = string.Join("\n", paraLines).Trim();
            if (!string.IsNullOrEmpty(joined))
            {
                FlushBullet();
                FlushNumbered();
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

        void FlushNumbered()
        {
            if (currentNumbered == null) return;
            segments.Add(currentNumbered);
            currentNumbered = null;
        }

        for (int i = 0; i < rawLines.Length; i++)
        {
            var rawLine = rawLines[i];
            var line = rawLine.TrimEnd('\r');

            // Code block delimiter
            if (!inCode && (line.TrimStart().StartsWith("```")))
            {
                FlushPara();
                FlushBullet();
                FlushNumbered();
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

            var trimmed = line.Trim();

            // Table detection
            if (trimmed.StartsWith("|") && trimmed.EndsWith("|") && trimmed.Count(c => c == '|') >= 2)
            {
                // Check if next line is a separator row (e.g. |---|---|)
                if (i + 1 < rawLines.Length)
                {
                    var nextTrimmed = rawLines[i + 1].Trim();
                    if (nextTrimmed.StartsWith("|") && nextTrimmed.Contains("-"))
                    {
                        FlushPara();
                        FlushBullet();
                        FlushNumbered();

                        var headers = ParseTableRow(trimmed);
                        var rows = new List<List<string>>();
                        i += 1; // skip separator row

                        // Parse following data rows
                        while (i + 1 < rawLines.Length)
                        {
                            var candidateRow = rawLines[i + 1].Trim();
                            if (candidateRow.StartsWith("|") && candidateRow.EndsWith("|"))
                            {
                                i++;
                                rows.Add(ParseTableRow(candidateRow));
                            }
                            else
                            {
                                break;
                            }
                        }

                        segments.Add(new TableSegment { Headers = headers, Rows = rows });
                        continue;
                    }
                }
            }

            // Heading detection (#, ##, ###)
            if (trimmed.StartsWith("# ") || trimmed.StartsWith("## ") || trimmed.StartsWith("### "))
            {
                FlushPara();
                FlushBullet();
                FlushNumbered();

                int level = trimmed.StartsWith("### ") ? 3 : trimmed.StartsWith("## ") ? 2 : 1;
                string headingText = trimmed.Substring(level + 1).Trim();
                segments.Add(new HeadingSegment { Level = level, Text = headingText });
                continue;
            }

            // Bullet item (- or *)
            if (trimmed.StartsWith("- ") || trimmed.StartsWith("* "))
            {
                FlushPara();
                FlushNumbered();
                var itemText = trimmed.Substring(2);
                if (currentBullet == null) currentBullet = new BulletListSegment();
                currentBullet.Items.Add(itemText);
                continue;
            }

            // Numbered item (e.g. 1. , 2. )
            var numMatch = Regex.Match(trimmed, @"^(\d+)\.\s+(.*)$");
            if (numMatch.Success)
            {
                FlushPara();
                FlushBullet();
                var itemText = numMatch.Groups[2].Value;
                if (currentNumbered == null) currentNumbered = new NumberedListSegment();
                currentNumbered.Items.Add(itemText);
                continue;
            }

            // Non-list line: flush pending lists
            if (currentBullet != null && !string.IsNullOrWhiteSpace(line)) FlushBullet();
            if (currentNumbered != null && !string.IsNullOrWhiteSpace(line)) FlushNumbered();

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

        // Flush remaining
        if (inCode && codeLines.Count > 0)
        {
            segments.Add(new CodeBlockSegment { Language = codeLang, Content = string.Join("\n", codeLines) });
        }
        FlushPara();
        FlushBullet();
        FlushNumbered();

        return segments;
    }

    private static List<string> ParseTableRow(string rowLine)
    {
        var trimmed = rowLine.Trim().Trim('|');
        return trimmed.Split('|').Select(c => c.Trim()).ToList();
    }

    // ─── Control builders ────────────────────────────────────────────────────

    private Control BuildHeading(int level, string text)
    {
        double fontSize = level == 1 ? 18 : level == 2 ? 15.5 : 13.5;
        var margin = level == 1 ? new Thickness(0, 10, 0, 3) : level == 2 ? new Thickness(0, 7, 0, 2) : new Thickness(0, 5, 0, 2);

        var tb = new SelectableTextBlock
        {
            FontSize = fontSize,
            FontWeight = FontWeight.SemiBold,
            Foreground = level == 1 ? Brushes.White : TextBrush,
            Margin = margin,
            TextWrapping = TextWrapping.Wrap
        };
        foreach (var inline in ParseInlines(text))
            tb.Inlines!.Add(inline);
        return tb;
    }

    private Control BuildParagraph(string text)
    {
        var tb = new SelectableTextBlock
        {
            FontSize = 13.5,
            LineHeight = 22,
            TextWrapping = TextWrapping.Wrap,
            Foreground = TextBrush,
            Margin = new Thickness(0, 2)
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
            Orientation = Orientation.Horizontal,
            Margin = new Thickness(0, 1),
            Children = { bullet, content }
        };
    }

    private Control BuildNumberedItem(int index, string text)
    {
        var badge = new TextBlock
        {
            Text = $"{index}.",
            Foreground = DimBrush,
            FontFamily = MonoFamily,
            FontSize = 12.5,
            Margin = new Thickness(0, 0, 8, 0),
            VerticalAlignment = VerticalAlignment.Top,
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
            Orientation = Orientation.Horizontal,
            Margin = new Thickness(0, 1),
            Children = { badge, content }
        };
    }

    private Control BuildTable(TableSegment tbl)
    {
        int colCount = Math.Max(tbl.Headers.Count, tbl.Rows.Count > 0 ? tbl.Rows.Max(r => r.Count) : 1);

        var colDefs = new ColumnDefinitions();
        for (int c = 0; c < colCount; c++)
        {
            colDefs.Add(new ColumnDefinition(1, GridUnitType.Star));
        }

        var tableGrid = new Grid
        {
            ColumnDefinitions = colDefs
        };

        int rowIndex = 0;

        // Header Row
        if (tbl.Headers.Count > 0)
        {
            tableGrid.RowDefinitions.Add(new RowDefinition(GridLength.Auto));

            var headerBg = new Border
            {
                Background = TableHeaderBg,
                BorderBrush = TableBorderBrush,
                BorderThickness = new Thickness(0, 0, 0, 1)
            };
            Grid.SetRow(headerBg, 0);
            Grid.SetColumnSpan(headerBg, colCount);
            tableGrid.Children.Add(headerBg);

            for (int c = 0; c < tbl.Headers.Count; c++)
            {
                var hText = tbl.Headers[c];
                var cell = new SelectableTextBlock
                {
                    Text = hText,
                    FontWeight = FontWeight.SemiBold,
                    FontSize = 12,
                    Foreground = Brushes.White,
                    Padding = new Thickness(10, 7),
                    VerticalAlignment = VerticalAlignment.Center
                };
                Grid.SetRow(cell, 0);
                Grid.SetColumn(cell, c);
                tableGrid.Children.Add(cell);
            }
            rowIndex++;
        }

        // Data Rows
        for (int r = 0; r < tbl.Rows.Count; r++)
        {
            tableGrid.RowDefinitions.Add(new RowDefinition(GridLength.Auto));
            var rowData = tbl.Rows[r];

            var rowBg = new Border
            {
                Background = r % 2 == 0 ? TableRowBg1 : TableRowBg2,
                BorderBrush = TableBorderBrush,
                BorderThickness = new Thickness(0, 0, 0, r == tbl.Rows.Count - 1 ? 0 : 1)
            };
            Grid.SetRow(rowBg, rowIndex);
            Grid.SetColumnSpan(rowBg, colCount);
            tableGrid.Children.Add(rowBg);

            for (int c = 0; c < rowData.Count && c < colCount; c++)
            {
                var cellText = rowData[c];
                var cell = new SelectableTextBlock
                {
                    FontSize = 12,
                    Foreground = TextBrush,
                    LineHeight = 18,
                    Padding = new Thickness(10, 6),
                    TextWrapping = TextWrapping.Wrap,
                    VerticalAlignment = VerticalAlignment.Center
                };
                foreach (var inline in ParseInlines(cellText))
                    cell.Inlines!.Add(inline);

                Grid.SetRow(cell, rowIndex);
                Grid.SetColumn(cell, c);
                tableGrid.Children.Add(cell);
            }
            rowIndex++;
        }

        var tableBorder = new Border
        {
            Background = TableRowBg1,
            BorderBrush = TableBorderBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(6),
            ClipToBounds = true,
            Margin = new Thickness(0, 6, 0, 6),
            Child = tableGrid
        };

        return new ScrollViewer
        {
            HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
            VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled,
            Content = tableBorder
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

        // Copy button with feedback checkmark
        var copyIcon = new PathIcon
        {
            Width = 12,
            Height = 12,
            Foreground = CodeMetaBrush,
            Data = Geometry.Parse("M4,2 C2.8954305,2 2,2.8954305 2,4 L2,14 C2,15.1045695 2.8954305,16 4,16 L12,16 C13.1045695,16 14,15.1045695 14,14 L14,4 C14,2.8954305 13.1045695,2 12,2 L4,2 Z M4,3 L12,3 C12.5522847,3 13,3.44771525 13,4 L13,14 C13,14.5522847 12.5522847,15 12,15 L4,15 C3.44771525,15 3,14.5522847 3,14 L3,4 C3,3.44771525 3.44771525,3 4,3 Z")
        };

        var checkText = new TextBlock
        {
            Text = "✓",
            FontSize = 11,
            FontWeight = FontWeight.Bold,
            Foreground = new SolidColorBrush(Color.Parse("#10B981")),
            IsVisible = false
        };

        var copyBtn = new Button
        {
            Content = new Panel { Children = { copyIcon, checkText } },
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            Padding = new Thickness(4),
            Cursor = new Cursor(StandardCursorType.Hand)
        };
        ToolTip.SetTip(copyBtn, "Copy code");

        var capturedContent = content;
        copyBtn.Click += async (_, _) =>
        {
            var clipboard = TopLevel.GetTopLevel(this)?.Clipboard;
            if (clipboard != null)
                await clipboard.SetTextAsync(capturedContent);

            copyIcon.IsVisible = false;
            checkText.IsVisible = true;
            await Task.Delay(1800);
            checkText.IsVisible = false;
            copyIcon.IsVisible = true;
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
            if (match.Index > lastIndex)
            {
                yield return new Run
                {
                    Text = text.Substring(lastIndex, match.Index - lastIndex),
                    Foreground = TextBrush
                };
            }

            var full = match.Value;
            if (full.StartsWith("**") && full.EndsWith("**") && full.Length >= 4)
            {
                var inner = match.Groups[2].Value;
                yield return new Run
                {
                    Text = inner,
                    FontWeight = FontWeight.Bold,
                    Foreground = Brushes.White
                };
            }
            else if (full.StartsWith("`") && full.EndsWith("`") && full.Length >= 2)
            {
                var code = match.Groups[3].Value;
                var codeBorder = new Border
                {
                    Background = CodeInlineBg,
                    CornerRadius = new CornerRadius(3),
                    Padding = new Thickness(4, 1),
                    Child = new TextBlock
                    {
                        Text = code,
                        FontFamily = MonoFamily,
                        FontSize = 11.5,
                        Foreground = new SolidColorBrush(Color.Parse("#F4F4F5"))
                    }
                };
                yield return new InlineUIContainer { Child = codeBorder };
            }
            else if (full.StartsWith("*") && full.EndsWith("*") && full.Length >= 2)
            {
                var inner = match.Groups[4].Value;
                yield return new Run
                {
                    Text = inner,
                    FontStyle = FontStyle.Italic,
                    Foreground = TextBrush
                };
            }

            lastIndex = match.Index + match.Length;
        }

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
