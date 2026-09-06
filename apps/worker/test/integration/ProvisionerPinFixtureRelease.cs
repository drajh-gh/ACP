using System;
using System.Threading.Tasks;
namespace Acp.Integration;
public static class ProvisionerPinFixtureRelease
{
    public static void ParallelDispose(IDisposable pins) => Parallel.For(0, 16, _ => pins.Dispose());
}
