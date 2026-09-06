using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Acp.Worker;

namespace Acp.Integration;

// Test-only same-assembly witness. No production host loads this file. Keep the
// helper alive after Run returns, distinguishing explicit disposal from OS exit.
public static class ProvisionerBridgePinObserver
{
    public static async Task<int> Run(WindowsWorkerScope scope)
    {
        int result = await WindowsProvisionerBridge.RunObserved(scope, Observe);
        Send(new { type = "bridge-returned", result });
        Thread.Sleep(15000); // Parent owns and kills this bounded idle fixture.
        return result;
    }

    private static void Observe(string stage, string path)
    {
        bool moved = false; int errorCode = 0;
        string target = path + "-observer-rename";
        try { Directory.Move(path, target); moved = true; }
        catch (IOException error) { errorCode = error.HResult & 65535; }
        catch (UnauthorizedAccessException error) { errorCode = error.HResult & 65535; }
        if (moved) Directory.Move(target, path);
        Send(new { type = "pin-observed", stage, moved, errorCode });
    }

    private static void Send(object value)
    {
        Console.Out.WriteLine(JsonSerializer.Serialize(value)); Console.Out.Flush();
    }
}
