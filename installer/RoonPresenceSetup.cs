using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;

namespace RoonPresenceSetup
{
    internal static class Program
    {
        private const string RepoZipUrl = "https://github.com/darthspaders/RoonPresence/archive/refs/heads/main.zip";
        private const string ExtractedFolderName = "RoonPresence-main";

        private static int Main(string[] args)
        {
            Console.Title = "RoonPresence Setup";
            Console.WriteLine("RoonPresence Setup Wizard");
            Console.WriteLine("-------------------------");
            Console.WriteLine("This installer downloads RoonPresence from GitHub, installs dependencies, and runs setup.");
            Console.WriteLine();

            var defaultInstallDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "RoonPresence"
            );
            var installDir = Ask("Install folder", defaultInstallDir);
            var createDesktopLauncher = AskYesNo("Create desktop launcher", true);
            Console.WriteLine();

            var nodeCommand = ResolveCommand("node.exe");
            var npmCommand = ResolveCommand("npm.cmd");

            if (!CommandWorks(nodeCommand, "--version"))
            {
                Console.Error.WriteLine("Node.js was not found. Install Node.js LTS, then run this setup again.");
                Pause();
                return 1;
            }

            if (!CommandWorks(npmCommand, "--version"))
            {
                Console.Error.WriteLine("npm was not found. Install Node.js LTS, then run this setup again.");
                Pause();
                return 1;
            }

            try
            {
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
                InstallFromGitHub(installDir);

                Console.WriteLine();
                Console.WriteLine("Installing dependencies...");
                var installCode = InstallDependencies(npmCommand, installDir);
                if (installCode != 0) return installCode;

                if (!File.Exists(Path.Combine(installDir, ".env")))
                {
                    Console.WriteLine();
                    Console.WriteLine("Starting guided setup...");
                    var setupCode = Run(npmCommand, "run setup", installDir);
                    if (setupCode != 0) return setupCode;
                }
                else
                {
                    Console.WriteLine("Existing .env found; keeping your current settings.");
                }

                WriteLauncherCommand(installDir);
                if (createDesktopLauncher) WriteDesktopLauncher(installDir);

                Console.WriteLine();
                Console.WriteLine("RoonPresence is installed.");
                Console.WriteLine("Install folder: " + installDir);
                Console.WriteLine("Run it with: " + Path.Combine(installDir, "RoonPresence.cmd"));
                Console.WriteLine();
                if (AskYesNo("Start RoonPresence now", true))
                {
                    return Run("cmd.exe", "/c RoonPresence.cmd", installDir);
                }

                Pause();
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("Setup failed: " + error.Message);
                Pause();
                return 1;
            }
        }

        private static void InstallFromGitHub(string installDir)
        {
            var tempRoot = Path.Combine(Path.GetTempPath(), "RoonPresenceSetup-" + Guid.NewGuid().ToString("N"));
            var zipPath = Path.Combine(tempRoot, "RoonPresence.zip");
            Directory.CreateDirectory(tempRoot);

            try
            {
                Console.WriteLine("Downloading RoonPresence...");
                using (var client = new WebClient())
                {
                    client.Headers.Add("user-agent", "RoonPresenceSetup/0.1.0");
                    client.DownloadFile(RepoZipUrl, zipPath);
                }

                Console.WriteLine("Extracting...");
                var extractDir = Path.Combine(tempRoot, "extract");
                Directory.CreateDirectory(extractDir);
                var expandCode = Run(
                    "powershell.exe",
                    "-NoProfile -ExecutionPolicy Bypass -Command \"Expand-Archive -LiteralPath '" +
                        zipPath.Replace("'", "''") +
                        "' -DestinationPath '" +
                        extractDir.Replace("'", "''") +
                        "' -Force\"",
                    tempRoot
                );
                if (expandCode != 0) throw new InvalidOperationException("Could not extract GitHub zip.");

                var sourceDir = Path.Combine(extractDir, ExtractedFolderName);
                if (!Directory.Exists(sourceDir)) throw new DirectoryNotFoundException(sourceDir);

                Directory.CreateDirectory(installDir);
                CopyDirectory(sourceDir, installDir);
            }
            finally
            {
                try
                {
                    if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, true);
                }
                catch
                {
                }
            }
        }

        private static void CopyDirectory(string sourceDir, string targetDir)
        {
            Directory.CreateDirectory(targetDir);

            foreach (var file in Directory.GetFiles(sourceDir))
            {
                var name = Path.GetFileName(file);
                if (string.Equals(name, ".env", StringComparison.OrdinalIgnoreCase)) continue;
                File.Copy(file, Path.Combine(targetDir, name), true);
            }

            foreach (var dir in Directory.GetDirectories(sourceDir))
            {
                var name = Path.GetFileName(dir);
                if (string.Equals(name, ".git", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(name, "node_modules", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.Equals(name, "dist", StringComparison.OrdinalIgnoreCase)) continue;
                CopyDirectory(dir, Path.Combine(targetDir, name));
            }
        }

        private static void WriteLauncherCommand(string installDir)
        {
            var path = Path.Combine(installDir, "RoonPresence.cmd");
            var content = "@echo off\r\ncd /d \"%~dp0\"\r\nnpm start\r\npause\r\n";
            File.WriteAllText(path, content, Encoding.ASCII);
        }

        private static void WriteDesktopLauncher(string installDir)
        {
            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            var path = Path.Combine(desktop, "RoonPresence.cmd");
            var content = "@echo off\r\ncd /d \"" + installDir + "\"\r\nnpm start\r\npause\r\n";
            File.WriteAllText(path, content, Encoding.ASCII);
        }

        private static int InstallDependencies(string npmCommand, string installDir)
        {
            var installCode = Run(npmCommand, "install", installDir);
            if (installCode == 0) return 0;

            Console.WriteLine();
            Console.WriteLine("npm install failed; retrying without package-lock...");
            try
            {
                var lockPath = Path.Combine(installDir, "package-lock.json");
                if (File.Exists(lockPath)) File.Delete(lockPath);
            }
            catch (Exception error)
            {
                Console.WriteLine("Could not remove package-lock.json: " + error.Message);
            }

            return Run(npmCommand, "install --no-package-lock", installDir);
        }
        private static string Ask(string prompt, string defaultValue)
        {
            Console.Write(prompt + " [" + defaultValue + "]: ");
            var answer = Console.ReadLine();
            return string.IsNullOrWhiteSpace(answer) ? defaultValue : answer.Trim();
        }

        private static bool AskYesNo(string prompt, bool defaultValue)
        {
            while (true)
            {
                Console.Write(prompt + " [" + (defaultValue ? "Y" : "n") + "]: ");
                var answer = Console.ReadLine();
                if (string.IsNullOrWhiteSpace(answer)) return defaultValue;
                if (answer.Equals("y", StringComparison.OrdinalIgnoreCase) || answer.Equals("yes", StringComparison.OrdinalIgnoreCase)) return true;
                if (answer.Equals("n", StringComparison.OrdinalIgnoreCase) || answer.Equals("no", StringComparison.OrdinalIgnoreCase)) return false;
                Console.WriteLine("Please answer yes or no.");
            }
        }

        private static string ResolveCommand(string fileName)
        {
            var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            var candidates = new[]
            {
                Path.Combine(programFiles, "nodejs", fileName),
                Path.Combine(programFilesX86, "nodejs", fileName)
            };

            foreach (var candidate in candidates)
            {
                if (File.Exists(candidate)) return candidate;
            }

            var path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var directory in path.Split(Path.PathSeparator))
            {
                if (string.IsNullOrWhiteSpace(directory)) continue;
                try
                {
                    var candidate = Path.Combine(directory.Trim(), fileName);
                    if (File.Exists(candidate)) return candidate;
                }
                catch
                {
                    // Ignore malformed PATH entries.
                }
            }

            return fileName;
        }

        private static bool CommandWorks(string fileName, string arguments)
        {
            try
            {
                return Run(fileName, arguments, Environment.CurrentDirectory, false) == 0;
            }
            catch
            {
                return false;
            }
        }

        private static int Run(string fileName, string arguments, string workingDirectory, bool echo = true)
        {
            if (echo) Console.WriteLine("> " + fileName + " " + arguments);
            using (var process = new Process())
            {
                process.StartInfo.FileName = fileName;
                process.StartInfo.Arguments = arguments;
                process.StartInfo.WorkingDirectory = workingDirectory;
                process.StartInfo.UseShellExecute = false;
                process.StartInfo.CreateNoWindow = false;
                process.Start();
                process.WaitForExit();
                return process.ExitCode;
            }
        }

        private static void Pause()
        {
            Console.WriteLine();
            Console.WriteLine("Press Enter to close.");
            Console.ReadLine();
        }
    }
}


