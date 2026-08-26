import 'dart:async';
import 'dart:convert';

import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:permission_handler/permission_handler.dart';

final _hangerService = Guid('a4e66a20-0fb0-4dce-8be0-18cf7bc82001');
final _hangerConfig = Guid('a4e66a21-0fb0-4dce-8be0-18cf7bc82001');
final _hangerStatus = Guid('a4e66a22-0fb0-4dce-8be0-18cf7bc82001');

class HangerBle {
  BluetoothDevice? _device;
  BluetoothCharacteristic? _config;
  BluetoothCharacteristic? _status;
  StreamSubscription<List<int>>? _statusSubscription;
  StreamSubscription<BluetoothConnectionState>? _connectionSubscription;
  final _events = StreamController<Map<String, dynamic>>.broadcast();

  Stream<Map<String, dynamic>> get events => _events.stream;
  bool get connected => _device != null && _config != null;

  Future<bool> _requestPermissions() async {
    final states = await [
      Permission.bluetoothScan,
      Permission.bluetoothConnect,
    ].request();
    return states.values.every((state) => state.isGranted);
  }

  Map<String, dynamic> _decode(List<int> bytes) {
    try {
      return Map<String, dynamic>.from(jsonDecode(utf8.decode(bytes)) as Map);
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  Future<Map<String, dynamic>> scan() async {
    if (!await _requestPermissions()) {
      return {
        'ok': false,
        'error': '블루투스 권한이 필요합니다.',
        'devices': <Map<String, dynamic>>[],
      };
    }
    final found = <String, ScanResult>{};
    StreamSubscription<List<ScanResult>>? subscription;
    try {
      try {
        await FlutterBluePlus.stopScan();
      } catch (_) {}
      await Future<void>.delayed(const Duration(milliseconds: 150));
      subscription = FlutterBluePlus.scanResults.listen((results) {
        for (final result in results) {
          if (result.advertisementData.serviceUuids.contains(_hangerService)) {
            found[result.device.remoteId.str] = result;
          }
        }
      });
      await FlutterBluePlus.startScan(
        withServices: [_hangerService],
        timeout: const Duration(seconds: 5),
      );
      await Future<void>.delayed(const Duration(milliseconds: 4800));
    } catch (_) {
      // Preserve devices discovered before Android stopped the scan.
    } finally {
      try {
        await FlutterBluePlus.stopScan();
      } catch (_) {}
      await subscription?.cancel();
    }
    final devices = found.values.toList()
      ..sort((a, b) => b.rssi.compareTo(a.rssi));
    return {
      'ok': true,
      'devices': devices.map((result) {
        final advertisedName = result.advertisementData.advName;
        final platformName = result.device.platformName;
        return {
          'deviceId': result.device.remoteId.str,
          'name': advertisedName.isNotEmpty
              ? advertisedName
              : (platformName.isNotEmpty ? platformName : '스마트 옷걸이'),
          'rssi': result.rssi,
        };
      }).toList(),
    };
  }

  Future<Map<String, dynamic>> connectSelected(String deviceId) async {
    if (!await _requestPermissions())
      return {'connected': false, 'error': '블루투스 권한이 필요합니다.'};
    try {
      await disconnect();
      final device = BluetoothDevice.fromId(deviceId);
      _device = device;
      await device.connect(
        timeout: const Duration(seconds: 10),
        autoConnect: false,
      );
      final services = await device.discoverServices();
      final service = services.firstWhere(
        (item) => item.uuid == _hangerService,
      );
      _config = service.characteristics.firstWhere(
        (item) => item.uuid == _hangerConfig,
      );
      _status = service.characteristics.firstWhere(
        (item) => item.uuid == _hangerStatus,
      );
      await _status!.setNotifyValue(true);
      _statusSubscription = _status!.lastValueStream.listen((bytes) {
        final info = _decode(bytes);
        if (info.isNotEmpty) _events.add({...info, 'source': 'hanger'});
      });
      _connectionSubscription = device.connectionState.listen((state) {
        if (state == BluetoothConnectionState.disconnected) {
          _config = null;
          _status = null;
          _events.add({
            'source': 'hanger',
            'type': 'transport',
            'connected': false,
          });
        }
      });
      final info = _decode(await _status!.read());
      _events.add({
        'source': 'hanger',
        'type': 'transport',
        'connected': true,
        'deviceId': deviceId,
      });
      return {
        'connected': true,
        'deviceId': deviceId,
        'name': device.platformName,
        'status': info,
      };
    } catch (error) {
      await disconnect();
      return {
        'connected': false,
        'error': '선택한 옷걸이와 연결하지 못했습니다. 전원과 거리를 확인해 주세요. ($error)',
      };
    }
  }

  Future<Map<String, dynamic>> configure(Map<String, dynamic> payload) async {
    if (!connected || _config == null)
      return {'ok': false, 'error': '먼저 옷걸이를 블루투스로 연결하세요.'};
    try {
      await _config!.write(
        utf8.encode(jsonEncode(payload)),
        withoutResponse: false,
      );
      return {'ok': true};
    } catch (error) {
      return {'ok': false, 'error': '옷걸이 명령 전송에 실패했습니다. ($error)'};
    }
  }

  Future<void> disconnect() async {
    await _statusSubscription?.cancel();
    await _connectionSubscription?.cancel();
    _statusSubscription = null;
    _connectionSubscription = null;
    try {
      await _device?.disconnect();
    } catch (_) {}
    _device = null;
    _config = null;
    _status = null;
  }

  Future<void> dispose() async {
    await disconnect();
    await _events.close();
  }
}
