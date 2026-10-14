using System;
using System.Drawing;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace Calvras
{
    public class SetupForm : Form
    {
        private ProgressBar progressBar;
        private Label statusLabel;
        private Button actionButton;

        public SetupForm()
        {
            this.Text = "Calvras — Local AI Coding Agent Setup";
            this.Width = 520;
            this.Height = 360;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.BackColor = Color.FromArgb(16, 16, 18);
            this.ForeColor = Color.White;
            this.Font = new Font("Segoe UI", 9.5f);

            // Title
            Label titleLabel = new Label();
            titleLabel.Text = "Calvras";
            titleLabel.Font = new Font("Segoe UI", 20f, FontStyle.Bold);
            titleLabel.ForeColor = Color.White;
            titleLabel.Location = new Point(32, 28);
            titleLabel.AutoSize = true;
            this.Controls.Add(titleLabel);

            // Subtitle
            Label subTitle = new Label();
            subTitle.Text = "Your Autonomous AI Coding Agent — Desktop Edition";
            subTitle.Font = new Font("Segoe UI", 10f, FontStyle.Regular);
            subTitle.ForeColor = Color.FromArgb(160, 160, 170);
            subTitle.Location = new Point(34, 72);
            subTitle.AutoSize = true;
            this.Controls.Add(subTitle);

            // Details box
            Panel box = new Panel();
            box.Location = new Point(32, 110);
            box.Size = new Size(440, 110);
            box.BackColor = Color.FromArgb(24, 24, 28);
            this.Controls.Add(box);

            Label feat1 = new Label();
            feat1.Text = "✔ Real filesystem access and terminal control";
            feat1.ForeColor = Color.FromArgb(200, 200, 210);
            feat1.Location = new Point(16, 14);
            feat1.AutoSize = true;
            box.Controls.Add(feat1);

            Label feat2 = new Label();
            feat2.Text = "✔ Autonomous think-and-work agent loop";
            feat2.ForeColor = Color.FromArgb(200, 200, 210);
            feat2.Location = new Point(16, 42);
            feat2.AutoSize = true;
            box.Controls.Add(feat2);

            Label feat3 = new Label();
            feat3.Text = "✔ Connected to your local projects & desktop";
            feat3.ForeColor = Color.FromArgb(200, 200, 210);
            feat3.Location = new Point(16, 70);
            feat3.AutoSize = true;
            box.Controls.Add(feat3);

            // Status label
            statusLabel = new Label();
            statusLabel.Text = "Ready to launch Calvras.";
            statusLabel.ForeColor = Color.FromArgb(140, 140, 150);
            statusLabel.Location = new Point(32, 240);
            statusLabel.AutoSize = true;
            this.Controls.Add(statusLabel);

            // Action button
            actionButton = new Button();
            actionButton.Text = "Launch Calvras";
            actionButton.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            actionButton.BackColor = Color.FromArgb(79, 70, 229);
            actionButton.ForeColor = Color.White;
            actionButton.FlatStyle = FlatStyle.Flat;
            actionButton.FlatAppearance.BorderSize = 0;
            actionButton.Location = new Point(320, 265);
            actionButton.Size = new Size(152, 38);
            actionButton.Cursor = Cursors.Hand;
            actionButton.Click += ActionButton_Click;
            this.Controls.Add(actionButton);
        }

        private void ActionButton_Click(object sender, EventArgs e)
        {
            try
            {
                statusLabel.Text = "Opening Calvras Desktop...";
                // Create Desktop Shortcut if WScript is accessible
                try
                {
                    string desktop = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
                    string shortcutPath = Path.Combine(desktop, "Calvras.url");
                    using (StreamWriter writer = new StreamWriter(shortcutPath))
                    {
                        writer.WriteLine("[InternetShortcut]");
                        writer.WriteLine("URL=https://calvras.com");
                        writer.WriteLine("IconIndex=0");
                        writer.WriteLine("IconFile=https://calvras.com/favicon.ico");
                    }
                }
                catch { }

                // Launch Calvras web app
                Process.Start(new ProcessStartInfo
                {
                    FileName = "https://calvras.com",
                    UseShellExecute = true
                });

                statusLabel.Text = "Calvras is running!";
                System.Threading.Thread.Sleep(800);
                this.Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show("Error starting Calvras: " + ex.Message, "Calvras", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
        }
    }
}
