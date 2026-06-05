using System;
using System.Diagnostics;
using System.IO;

namespace RoonPresenceLauncher
{
    internal static class Program
    {
        private static Process childProcess;

        private static int Main(string[] args)
        {
            Console.Title = "RoonPresence";
            Console.WriteLine("RoonPresence Launcher");
            Console.WriteLine("---------------------");

            var appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (!File.Exists(Path.Combine(appDir, "package.json")))
            {
                Console.Error.WriteLine("Could not find package.json next to this launcher.");
                Console.Error.WriteLine("Place RoonPresence.exe in the RoonPresence project folder and run it again.");
                Pause();
                return 1;
            }

            Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs eventArgs)
            {
                eventArgs.Cancel = true;
                TryStopChild();
            };

            var nodeCommand = ResolveCommand("node.exe");
            var npmCommand = ResolveCommand("npm.cmd");

            if (!CommandExists(nodeCommand, "--version", appDir, "Node.js was not found. Install Node.js LTS, then run this launcher again."))
            {
                Pause();
                return 1;
            }

            if (!CommandExists(npmCommand, "--version", appDir, "npm was not found. Install Node.js LTS, then run this launcher again."))
            {
                Pause();
                return 1;
            }

            if (!Directory.Exists(Path.Combine(appDir, "node_modules")))
            {
                Console.WriteLine();
                Console.WriteLine("Installing dependencies...");
                var installCode = Run(npmCommand, "install", appDir);
                if (installCode != 0)
                {
                    Console.Error.WriteLine("npm install failed.");
                    Pause();
                    return installCode;
                }
            }

            if (!File.Exists(Path.Combine(appDir, ".env")))
            {
                Console.WriteLine();
                Console.WriteLine("No .env file found. Starting guided setup...");
                var setupCode = Run(npmCommand, "run setup", appDir);
                if (setupCode != 0)
                {
                    Console.Error.WriteLine("Setup did not complete.");
                    Pause();
                    return setupCode;
                }
            }

            Console.WriteLine();
            Console.WriteLine("Starting RoonPresence...");
            Console.WriteLine("Close this window or press Ctrl+C to stop.");
            Console.WriteLine();

            return Run(npmCommand, "start", appDir);
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

        private static bool CommandExists(string fileName, string arguments, string workingDirectory, string failureMessage)
        {
            try
            {
                var exitCode = Run(fileName, arguments, workingDirectory, false);
                if (exitCode == 0) return true;
            }
            catch
            {
                // Fall through to user-facing message.
            }

            Console.Error.WriteLine(failureMessage);
            return false;
        }

        private static int Run(string fileName, string arguments, string workingDirectory, bool echo = true)
        {
            if (echo)
            {
                Console.WriteLine("> " + fileName + " " + arguments);
            }

            using (var process = new Process())
            {
                process.StartInfo.FileName = fileName;
                process.StartInfo.Arguments = arguments;
                process.StartInfo.WorkingDirectory = workingDirectory;
                process.StartInfo.UseShellExecute = false;
                process.StartInfo.CreateNoWindow = false;
                childProcess = process;
                process.Start();
                process.WaitForExit();
                childProcess = null;
                return process.ExitCode;
            }
        }

        private static void TryStopChild()
        {
            try
            {
                if (childProcess != null && !childProcess.HasExited)
                {
                    childProcess.Kill();
                }
            }
            catch
            {
                // Best-effort shutdown.
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

