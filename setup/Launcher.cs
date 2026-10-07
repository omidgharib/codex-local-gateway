using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Diagnostics;
class Launcher {
  static int Main(string[] args) {
    string temp = Path.Combine(Path.GetTempPath(), "CodexGateway-" + Guid.NewGuid());
    try {
      Directory.CreateDirectory(temp);
      using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
      using (var zip = new ZipArchive(stream, ZipArchiveMode.Read)) {
        zip.ExtractToDirectory(temp);
      }
      if (args.Length == 1 && args[0] == "--verify") {
        foreach (var file in new [] { "install.ps1", "app/src/server.mjs", "app/runtime/node.exe", "app/runtime/codex.exe", "app/public/dashboard.html" })
          if (!File.Exists(Path.Combine(temp, file))) throw new Exception("Missing payload file: " + file);
        Console.WriteLine("Installer payload verified."); return 0;
      }
      var start = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(temp, "install.ps1") + "\"");
      start.UseShellExecute = false;
      using (var process = Process.Start(start)) { process.WaitForExit(); return process.ExitCode; }
    } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    finally { try { Directory.Delete(temp, true); } catch {} }
  }
}
