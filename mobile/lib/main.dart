import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:permission_handler/permission_handler.dart';

const _webUrl = 'https://otkok-live.vercel.app/';
const _trustedHost = 'otkok-live.vercel.app';
final _gatewayService = Guid('a4e66a10-0fb0-4dce-8be0-18cf7bc82001');
final _gatewayStatus = Guid('a4e66a12-0fb0-4dce-8be0-18cf7bc82001');
final _localStatus = Guid('a4e66a13-0fb0-4dce-8be0-18cf7bc82001');
final _localCommand = Guid('a4e66a14-0fb0-4dce-8be0-18cf7bc82001');

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const OtkokApp());
}

class OtkokApp extends StatelessWidget {
  const OtkokApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: '옷콕',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(colorSchemeSeed: const Color(0xff2d63e5), useMaterial3: true),
        home: const OtkokWebApp(),
      );
}

class GatewayBle {
  final _storage = const FlutterSecureStorage();
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  final Map<String, Completer<Map<String, dynamic>>> _ackWaiters = {};
  BluetoothDevice? _device;
  BluetoothCharacteristic? _command;
  BluetoothCharacteristic? _config;
  StreamSubscription<List<int>>? _statusSubscription;
  StreamSubscription<List<int>>? _gatewayStatusSubscription;
  StreamSubscription<BluetoothConnectionState>? _connectionSubscription;
  Future<Map<String, dynamic>>? _connecting;
  String gatewayId = '';

  Stream<Map<String, dynamic>> get events => _events.stream;
  bool get connected => _device != null && _command != null && gatewayId.isNotEmpty;

  Future<Map<String, dynamic>> connect(List<String> expectedGatewayIds) {
    final active = _connecting;
    if (active != null) return active;
    final request = _connect(expectedGatewayIds);
    _connecting = request;
    return request.whenComplete(() {
      if (identical(_connecting, request)) _connecting = null;
    });
  }

  Future<Map<String, dynamic>> _connect(List<String> expectedGatewayIds) async {
    final expected = expectedGatewayIds.map((id) => id.toUpperCase()).toSet();
    if (connected && (expected.isEmpty || expected.contains(gatewayId))) return _connectionResult(true);
    if (!await _requestPermissions()) return {'connected': false, 'error': '블루투스 권한이 필요합니다.'};

    final savedDeviceId = await _storage.read(key: 'otkok_gateway_ble_device');
    if (savedDeviceId != null && savedDeviceId.isNotEmpty) {
      try {
        if (await _attach(BluetoothDevice.fromId(savedDeviceId), expected)) return _connectionResult(true);
      } catch (_) {
        await disconnect();
      }
    }

    final found = <String, ScanResult>{};
    final firstCandidate = Completer<void>();
    StreamSubscription<List<ScanResult>>? scanSubscription;
    try {
      _events.add({'type': 'scan', 'state': 'started'});
      scanSubscription = FlutterBluePlus.scanResults.listen((results) {
        for (final result in results) {
          if (result.advertisementData.serviceUuids.contains(_gatewayService)) {
            found[result.device.remoteId.str] = result;
            if (!firstCandidate.isCompleted) firstCandidate.complete();
          }
        }
      });
      await FlutterBluePlus.startScan(withServices: [_gatewayService], timeout: const Duration(seconds: 5));
      await Future.any([
        firstCandidate.future.then((_) => Future<void>.delayed(const Duration(milliseconds: 650))),
        Future<void>.delayed(const Duration(seconds: 5)),
      ]);
    } catch (_) {
      // Candidates collected before an Android controller timeout remain valid.
    } finally {
      try { await FlutterBluePlus.stopScan(); } catch (_) {}
      await scanSubscription?.cancel();
      _events.add({'type': 'scan', 'state': 'stopped', 'count': found.length});
    }

    final candidates = found.values.toList()..sort((a, b) => b.rssi.compareTo(a.rssi));
    for (final candidate in candidates) {
      try {
        if (await _attach(candidate.device, expected)) return _connectionResult(true);
      } catch (_) {
        await disconnect();
      }
    }
    return {'connected': false, 'error': expected.isEmpty ? '근처 옷봉을 찾지 못했습니다.' : '이 계정에 등록된 근처 옷봉을 찾지 못했습니다.'};
  }

  Future<bool> _attach(BluetoothDevice device, Set<String> expected) async {
    await disconnect();
    _device = device;
    await device.connect(timeout: const Duration(seconds: 9), autoConnect: false);
    final services = await device.discoverServices();
    final service = services.firstWhere((item) => item.uuid == _gatewayService);
    final status = service.characteristics.firstWhere((item) => item.uuid == _gatewayStatus);
    final localStatus = service.characteristics.firstWhere((item) => item.uuid == _localStatus);
    _config = service.characteristics.firstWhere((item) => item.uuid == Guid('a4e66a11-0fb0-4dce-8be0-18cf7bc82001'));
    _command = service.characteristics.firstWhere((item) => item.uuid == _localCommand);
    await status.setNotifyValue(true);
    await localStatus.setNotifyValue(true);
    _gatewayStatusSubscription = status.lastValueStream.listen(_onStatus);
    _statusSubscription = localStatus.lastValueStream.listen(_onStatus);
    final statusInfo = _decode(await status.read());
    gatewayId = (statusInfo['gatewayId'] ?? statusInfo['deviceId'] ?? '').toString().toUpperCase();
    if (gatewayId.isEmpty || (expected.isNotEmpty && !expected.contains(gatewayId))) {
      await disconnect();
      return false;
    }
    _connectionSubscription = device.connectionState.listen((state) {
      if (state == BluetoothConnectionState.disconnected) {
        _command = null;
        final previous = gatewayId;
        gatewayId = '';
        _events.add({'type': 'transport', 'connected': false, 'gatewayId': previous});
      }
    });
    await _storage.write(key: 'otkok_gateway_ble_device', value: device.remoteId.str);
    _events.add({'type': 'transport', 'connected': true, 'gatewayId': gatewayId});
    return true;
  }

  void _onStatus(List<int> bytes) {
    final info = _decode(bytes);
    if (info.isEmpty) return;
    final hangerId = (info['hangerId'] ?? '').toString().toUpperCase();
    if (info['type'] == 'command_ack' && hangerId.isNotEmpty) _ackWaiters.remove(hangerId)?.complete(info);
    _events.add(info);
  }

  Map<String, dynamic> _decode(List<int> bytes) {
    try { return Map<String, dynamic>.from(jsonDecode(utf8.decode(bytes)) as Map); } catch (_) { return <String, dynamic>{}; }
  }

  Future<Map<String, dynamic>> command(String action, List<String> targets, int durationMs) async {
    if (!connected || targets.isEmpty) return {'ok': false, 'error': '근처 BLE 연결이 없습니다.'};
    Object? lastError;
    for (var attempt = 0; attempt < 2; attempt++) {
      final pending = <Future<Map<String, dynamic>>>[];
      for (final target in targets) {
        final id = target.toUpperCase();
        final waiter = Completer<Map<String, dynamic>>();
        _ackWaiters[id] = waiter;
        pending.add(waiter.future.timeout(const Duration(milliseconds: 850)));
      }
      try {
        await _command!.write(utf8.encode(jsonEncode({'action': action, 'targets': targets, 'durationMs': durationMs})), withoutResponse: false);
        final acknowledgements = await Future.wait(pending);
        if (acknowledgements.any((ack) => (ack['result'] ?? 'ERROR').toString().toUpperCase() != 'OK')) throw StateError('옷걸이가 명령을 거부했습니다.');
        return {'ok': true, 'transport': 'ble', 'gatewayId': gatewayId};
      } catch (error) {
        lastError = error;
        for (final target in targets) { _ackWaiters.remove(target.toUpperCase()); }
        if (attempt == 0 && connected) await Future<void>.delayed(const Duration(milliseconds: 180));
      }
    }
    return {'ok': false, 'error': '근처 옷걸이의 실제 응답을 받지 못했습니다. ($lastError)'};
  }


  Future<Map<String, dynamic>> configure(Map<String, dynamic> payload) async {
    if (!connected || _config == null) return {'ok': false, 'error': '근처 BLE 연결이 없습니다.'};
    try {
      await _config!.write(utf8.encode(jsonEncode(payload)), withoutResponse: false);
      return {'ok': true};
    } catch (error) {
      return {'ok': false, 'error': '옷봉 설정 명령 전송에 실패했습니다. ($error)'};
    }
  }
  Map<String, dynamic> _connectionResult(bool value) => {'connected': value, 'gatewayId': gatewayId, 'deviceId': _device?.remoteId.str ?? '', 'name': _device?.platformName ?? '스마트 옷봉'};

  Future<bool> _requestPermissions() async {
    final states = await [Permission.bluetoothScan, Permission.bluetoothConnect].request();
    return states.values.every((state) => state.isGranted);
  }

  Future<void> disconnect() async {
    await _statusSubscription?.cancel();
    await _gatewayStatusSubscription?.cancel();
    await _connectionSubscription?.cancel();
    _statusSubscription = null;
    _gatewayStatusSubscription = null;
    _connectionSubscription = null;
    for (final waiter in _ackWaiters.values) { if (!waiter.isCompleted) waiter.completeError(StateError('BLE 연결이 끊겼습니다.')); }
    _ackWaiters.clear();
    try { await _device?.disconnect(); } catch (_) {}
    _device = null;
    _command = null;
    _config = null;
    gatewayId = '';
  }

  Future<void> dispose() async { await disconnect(); await _events.close(); }
}

class OtkokWebApp extends StatefulWidget {
  const OtkokWebApp({super.key});
  @override
  State<OtkokWebApp> createState() => _OtkokWebAppState();
}

class _OtkokWebAppState extends State<OtkokWebApp> with WidgetsBindingObserver {
  final _ble = GatewayBle();
  InAppWebViewController? _controller;
  StreamSubscription<Map<String, dynamic>>? _bleEvents;
  double _progress = 0;

  bool _trusted(WebUri? uri) => uri != null && uri.scheme == 'https' && uri.host == _trustedHost;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _bleEvents = _ble.events.listen(_emitBleEvent);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _bleEvents?.cancel();
    _ble.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _controller?.evaluateJavascript(source: "window.dispatchEvent(new Event('otkokNativeResume'));");
  }

  Future<bool> _controllerIsTrusted(InAppWebViewController controller) async => _trusted(await controller.getUrl());

  Future<void> _emitBleEvent(Map<String, dynamic> event) async {
    final controller = _controller;
    if (controller == null || !await _controllerIsTrusted(controller)) return;
    await controller.evaluateJavascript(source: "window.dispatchEvent(new CustomEvent('otkokNativeBleStatus',{detail:${jsonEncode(event)}}));");
  }

  Future<void> _installBridge(InAppWebViewController controller, WebUri? uri) async {
    if (!_trusted(uri)) return;
    await controller.evaluateJavascript(source: "window.__OTKOK_NATIVE_APK__=true;window.dispatchEvent(new Event('otkokNativeReady'));");
  }

  @override
  Widget build(BuildContext context) => PopScope(
        canPop: false,
        onPopInvokedWithResult: (didPop, result) async { if (!didPop && await _controller?.canGoBack() == true) await _controller?.goBack(); },
        child: Scaffold(
          body: SafeArea(
            bottom: false,
            child: Stack(children: [
              InAppWebView(
                initialUrlRequest: URLRequest(url: WebUri(_webUrl)),
                initialSettings: InAppWebViewSettings(javaScriptEnabled: true, domStorageEnabled: true, databaseEnabled: true, cacheEnabled: true, supportZoom: false, mediaPlaybackRequiresUserGesture: false, allowsInlineMediaPlayback: true, useShouldOverrideUrlLoading: true),
                onWebViewCreated: (controller) {
                  _controller = controller;
                  controller.addJavaScriptHandler(handlerName: 'otkokBleConnect', callback: (arguments) async {
                    if (!await _controllerIsTrusted(controller)) return {'connected': false, 'error': '허용되지 않은 페이지입니다.'};
                    final data = arguments.isNotEmpty && arguments.first is Map ? Map<String, dynamic>.from(arguments.first as Map) : <String, dynamic>{};
                    final expected = ((data['expectedGatewayIds'] as List?) ?? const []).map((value) => value.toString()).toList();
                    return _ble.connect(expected);
                  });
                  controller.addJavaScriptHandler(handlerName: 'otkokBleCommand', callback: (arguments) async {
                    if (!await _controllerIsTrusted(controller)) return {'ok': false, 'error': '허용되지 않은 페이지입니다.'};
                    final data = arguments.isNotEmpty && arguments.first is Map ? Map<String, dynamic>.from(arguments.first as Map) : <String, dynamic>{};
                    return _ble.command((data['action'] ?? 'local_find').toString(), ((data['targets'] as List?) ?? const []).map((value) => value.toString()).toList(), int.tryParse((data['durationMs'] ?? 0).toString()) ?? 0);
                  });
                  controller.addJavaScriptHandler(handlerName: 'otkokBleConfig', callback: (arguments) async {
                    if (!await _controllerIsTrusted(controller)) return {'ok': false, 'error': '허용되지 않은 페이지입니다.'};
                    final data = arguments.isNotEmpty && arguments.first is Map ? Map<String, dynamic>.from(arguments.first as Map) : <String, dynamic>{};
                    return _ble.configure(data);
                  });                  controller.addJavaScriptHandler(handlerName: 'otkokBleDisconnect', callback: (_) async {
                    if (!await _controllerIsTrusted(controller)) return {'ok': false};
                    await _ble.disconnect();
                    return {'ok': true};
                  });
                },
                onLoadStop: _installBridge,
                onProgressChanged: (_, progress) { if (mounted) setState(() => _progress = progress / 100); },
                onPermissionRequest: (_, request) async => PermissionResponse(resources: request.resources, action: _trusted(request.origin) ? PermissionResponseAction.GRANT : PermissionResponseAction.DENY),
                shouldOverrideUrlLoading: (_, action) async => _trusted(action.request.url) ? NavigationActionPolicy.ALLOW : NavigationActionPolicy.CANCEL,
              ),
              if (_progress < 1) LinearProgressIndicator(value: _progress),
            ]),
          ),
        ),
      );
}