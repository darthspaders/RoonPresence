using System;
using System.Diagnostics;
using System.IO;

namespace RoonPresenceLauncher
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            Console.Title = "RoonPresence";

            var workingDirectory = FindWorkingDirectory();
            if (string.IsNullOrWhiteSpace(workingDirectory))
            {
                Console.Error.WriteLine("Could not find the RoonPresence working directory.");
                Console.Error.WriteLine("Place RoonPresence.exe inside the RoonPresence folder, or install to:");
                Console.Error.WriteLine(Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "RoonPresence"
                ));
                Pause();
                return 1;
            }

            Directory.SetCurrentDirectory(workingDirectory);
            Console.WriteLine("RoonPresence");
            Console.WriteLine("Working directory: " + workingDirectory);
            Console.WriteLine();

            var npmCommand = ResolveCommand("npm.cmd");
            if (!CommandWorks(ResolveCommand("node.exe"), "--version") || !CommandWorks(npmCommand, "--version"))
            {
                Console.Error.WriteLine("Node.js LTS was not found. Install Node.js LTS, then start RoonPresence again.");
                Pause();
                return 1;
            }

            if (!Directory.Exists(Path.Combine(workingDirectory, "node_modules")))
            {
                Console.WriteLine("Installing dependencies...");
                var installCode = Run(npmCommand, "install", workingDirectory);
                if (installCode != 0)
                {
                    Pause();
                    return installCode;
                }
            }

            if (!File.Exists(Path.Combine(workingDirectory, ".env")))
            {
                Console.WriteLine("Starting guided setup...");
                var setupCode = Run(npmCommand, "run setup", workingDirectory);
                if (setupCode != 0)
                {
                    Pause();
                    return setupCode;
                }
            }

            return Run(npmCommand, "start", workingDirectory);
        }

        private static string FindWorkingDirectory()
        {
            var exeDir = AppDomain.CurrentDomain.BaseDirectory;
            if (IsProjectDirectory(exeDir)) return exeDir;

            var parentInfo = Directory.GetParent(exeDir);
            var parentDir = parentInfo == null ? "" : parentInfo.FullName;
            if (IsProjectDirectory(parentDir)) return parentDir;

            var localInstallDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "RoonPresence"
            );
            if (IsProjectDirectory(localInstallDir)) return localInstallDir;

            var currentDir = Environment.CurrentDirectory;
            if (IsProjectDirectory(currentDir)) return currentDir;

            return "";
        }

        private static bool IsProjectDirectory(string directory)
        {
            if (string.IsNullOrWhiteSpace(directory)) return false;
            return File.Exists(Path.Combine(directory, "package.json")) &&
                Directory.Exists(Path.Combine(directory, "src"));
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
