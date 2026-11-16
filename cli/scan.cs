using System;
using System.Threading;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

internal static class Scanner
{
    private static int Main(string[] args)
    {
        try { return Scan(args); }
        catch (Exception e) { Console.Error.WriteLine("Windows Bluetooth: " + e.Message); return 1; }
    }

    private static readonly Guid WeightService = Guid.Parse("0000181d-0000-1000-8000-00805f9b34fb");
    private static readonly Guid WeightMeasurement = Guid.Parse("00002a9d-0000-1000-8000-00805f9b34fb");

    private static void Emit(BluetoothLEAdvertisementReceivedEventArgs packet, string service, byte[] bytes, int offset)
    {
        Console.WriteLine("{0:X12} {1} {2} {3} {4} {5}", packet.BluetoothAddress,
            packet.RawSignalStrengthInDBm, service, BitConverter.ToString(bytes, offset).Replace("-", ""),
            packet.AdvertisementType,
            Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(packet.Advertisement.LocalName ?? "")));
    }

    private static Task<T> AsTask<T>(Windows.Foundation.IAsyncOperation<T> operation)
    {
        var result = new TaskCompletionSource<T>();
        operation.Completed = (completed, status) =>
        {
            try { result.TrySetResult(completed.GetResults()); }
            catch (Exception error) { result.TrySetException(error); }
        };
        return result.Task;
    }

    private static async Task ListenForWeight(BluetoothLEAdvertisementReceivedEventArgs packet, Task stopping)
    {
        var address = packet.BluetoothAddress;
        using (var device = await AsTask(BluetoothLEDevice.FromBluetoothAddressAsync(address, packet.BluetoothAddressType)))
        {
            if (device == null || stopping.IsCompleted) return;
            var services = await AsTask(device.GetGattServicesForUuidAsync(WeightService));
            foreach (var service in services.Services)
            using (service)
            {
                if (stopping.IsCompleted) continue;
                var measurements = await AsTask(service.GetCharacteristicsForUuidAsync(WeightMeasurement));
                foreach (var measurement in measurements.Characteristics)
                {
                    if (!measurement.CharacteristicProperties.HasFlag(GattCharacteristicProperties.Indicate)) continue;
                    var received = new TaskCompletionSource<bool>();
                    Windows.Foundation.TypedEventHandler<GattCharacteristic, GattValueChangedEventArgs> onWeight = (sender, args) =>
                    {
                        using (var reader = DataReader.FromBuffer(args.CharacteristicValue))
                        {
                            var bytes = new byte[reader.UnconsumedBufferLength];
                            reader.ReadBytes(bytes);
                            Emit(packet, "181D", bytes, 0);
                        }
                        received.TrySetResult(true);
                    };
                    measurement.ValueChanged += onWeight;
                    try
                    {
                        var status = await AsTask(measurement.WriteClientCharacteristicConfigurationDescriptorAsync(
                            GattClientCharacteristicConfigurationDescriptorValue.Indicate));
                        if (status != GattCommunicationStatus.Success) continue;
                        await Task.WhenAny(stopping, received.Task, Task.Delay(45000));
                    }
                    finally { measurement.ValueChanged -= onWeight; }
                }
            }
        }
    }

    private static int Scan(string[] args)
    {
        var stopped = new ManualResetEvent(false);
        var error = BluetoothError.Success;
        var watcher = new BluetoothLEAdvertisementWatcher();
        watcher.ScanningMode = BluetoothLEScanningMode.Active;
        var diagnostics = args.Length > 0 && args[0] == "--identify";
        var targetIndex = diagnostics ? 1 : 0;
        var target = args.Length > targetIndex ? args[targetIndex] : "";
        var excluded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; !diagnostics && i < args.Length; i++) excluded.Add(args[i]);
        var active = new HashSet<ulong>();
        var stopping = new TaskCompletionSource<bool>();
        watcher.Received += (sender, packet) =>
        {
            var address = packet.BluetoothAddress.ToString("X12");
            if (target.Length != 0 && !String.Equals(address, target, StringComparison.OrdinalIgnoreCase)) return;
            if (excluded.Contains(address)) return;
            if (!diagnostics && (!String.IsNullOrEmpty(packet.Advertisement.LocalName) || packet.Advertisement.ManufacturerData.Count > 0))
            {
                Console.WriteLine("META {0} {1} {2}", address,
                    Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(packet.Advertisement.LocalName ?? "")),
                    String.Join(",", packet.Advertisement.ManufacturerData.Select(data => data.CompanyId.ToString("X4"))));
            }
            if (diagnostics)
            {
                Console.WriteLine("IDENT {0} name={1} services={2} companyIds={3} sections={4} type={5} rssi={6}", address,
                    packet.Advertisement.LocalName, String.Join(",", packet.Advertisement.ServiceUuids),
                    String.Join(",", packet.Advertisement.ManufacturerData.Select(data => data.CompanyId.ToString("X4"))),
                    String.Join(",", packet.Advertisement.DataSections.Select(data => data.DataType.ToString("X2") + ":" + data.Data.Length)),
                    packet.AdvertisementType, packet.RawSignalStrengthInDBm);
            }
            foreach (var section in packet.Advertisement.GetSectionsByType(0x16))
            {
                if (section.Data.Length < 2) continue;
                using (var reader = DataReader.FromBuffer(section.Data))
                {
                    var bytes = new byte[section.Data.Length];
                    reader.ReadBytes(bytes);
                    if (bytes[0] != 0x1b || bytes[1] != 0x18) continue;
                    Emit(packet, "181B", bytes, 2);
                }
            }
            if (diagnostics || !packet.Advertisement.ServiceUuids.Contains(WeightService)) return;
            lock (active) { if (!active.Add(packet.BluetoothAddress)) return; }
            Task.Run(async () =>
            {
                try { await ListenForWeight(packet, stopping.Task); }
                catch (Exception e) { Console.Error.WriteLine("Weight Scale " + address + ": " + e.Message); }
                await Task.Delay(1000);
                lock (active) { active.Remove(packet.BluetoothAddress); }
            });
        };
        watcher.Stopped += (sender, result) => { error = result.Error; stopped.Set(); };
        watcher.Start();
        for (var attempt = 0; attempt < 40 &&
            watcher.Status == BluetoothLEAdvertisementWatcherStatus.Created; attempt++)
        {
            if (stopped.WaitOne(50)) break;
        }
        if (watcher.Status == BluetoothLEAdvertisementWatcherStatus.Started)
        {
            Console.WriteLine("READY");
            var stdin = new Thread(() => { Console.ReadLine(); watcher.Stop(); });
            stdin.IsBackground = true;
            stdin.Start();
            stopped.WaitOne();
            stopping.TrySetResult(true);
            if (error == BluetoothError.Success) return 0;
        }
        else
        {
            stopped.WaitOne(1500);
        }
        Console.Error.WriteLine("Windows Bluetooth: " +
            (error == BluetoothError.Success ? watcher.Status.ToString() : error.ToString()));
        return 1;
    }
}
