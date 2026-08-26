import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';

const _apiBase = 'https://otkok-live.vercel.app';
final _gatewayService = Guid('a4e66a10-0fb0-4dce-8be0-18cf7bc82001');
final _localStatus = Guid('a4e66a13-0fb0-4dce-8be0-18cf7bc82001');
final _localCommand = Guid('a4e66a14-0fb0-4dce-8be0-18cf7bc82001');

void main() => runApp(const OtkokApp());

class OtkokApp extends StatelessWidget {
  const OtkokApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: '옷콕',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff2d63e5)),
          useMaterial3: true,
        ),
        home: const SessionGate(),
      );
}

class ApiException implements Exception {
  ApiException(this.message, this.status);
  final String message;
  final int status;
  @override
  String toString() => message;
}

class OtkokApi {
  OtkokApi(this.token);
  String? token;
  Future<dynamic> call(String path, {String method = 'GET', Object? body}) async {
    for (var attempt = 0; attempt < 3; attempt++) {
      final request = http.Request(method, Uri.parse('$_apiBase$path'));
      request.headers['content-type'] = 'application/json';
      if (token != null && token!.isNotEmpty) request.headers['authorization'] = 'Bearer $token';
      if (body != null) request.body = jsonEncode(body);
      final streamed = await request.send();
      final text = await streamed.stream.bytesToString();
      dynamic decoded;
      try { decoded = text.isEmpty ? <String, dynamic>{} : jsonDecode(text); } catch (_) { decoded = <String, dynamic>{}; }
      if (streamed.statusCode >= 200 && streamed.statusCode < 300) return decoded;
      if (<int>[502, 503, 504].contains(streamed.statusCode) && attempt < 2) {
        await Future<void>.delayed(Duration(milliseconds: 700 * (attempt + 1)));
        continue;
      }
      throw ApiException((decoded is Map ? decoded['error'] : null)?.toString() ?? 'HTTP ${streamed.statusCode}', streamed.statusCode);
    }
    throw ApiException('서버 연결을 다시 시도해 주세요.', 503);
  }
}

/// Native BLE stays alive while the app process is alive. It never bypasses
/// server ownership; it only carries already-owned local LED commands faster.
class GatewayBle {
  BluetoothDevice? _device;
  BluetoothCharacteristic? _command;
  StreamSubscription<List<ScanResult>>? _scanSub;
  StreamSubscription<List<int>>? _statusSub;
  StreamSubscription<BluetoothConnectionState>? _connectionSub;
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get events => _events.stream;
  bool get connected => _device != null && _command != null;

  Future<bool> connect({Duration timeout = const Duration(seconds: 12)}) async {
    if (connected) return true;
    if (!await _permissions()) return false;
    final completer = Completer<BluetoothDevice>();
    _scanSub?.cancel();
    _scanSub = FlutterBluePlus.scanResults.listen((results) {
      for (final result in results) {
        final services = result.advertisementData.serviceUuids;
        if (services.contains(_gatewayService) && !completer.isCompleted) {
          completer.complete(result.device);
        }
      }
    });
    try {
      await FlutterBluePlus.startScan(withServices: [_gatewayService], timeout: timeout);
      final device = await completer.future.timeout(timeout);
      await FlutterBluePlus.stopScan();
      await _scanSub?.cancel();
      _device = device;
      _connectionSub = device.connectionState.listen((state) {
        if (state == BluetoothConnectionState.disconnected) {
          _command = null;
          _events.add({'type': 'transport', 'connected': false});
        }
      });
      await device.connect(timeout: const Duration(seconds: 10), autoConnect: false);
      final services = await device.discoverServices();
      final gateway = services.firstWhere((service) => service.uuid == _gatewayService);
      _command = gateway.characteristics.firstWhere((c) => c.uuid == _localCommand);
      final status = gateway.characteristics.firstWhere((c) => c.uuid == _localStatus);
      await status.setNotifyValue(true);
      _statusSub = status.lastValueStream.listen((bytes) {
        try { _events.add(Map<String, dynamic>.from(jsonDecode(utf8.decode(bytes)) as Map)); } catch (_) {}
      });
      _events.add({'type': 'transport', 'connected': true, 'name': device.platformName});
      return true;
    } catch (_) {
      await disconnect();
      return false;
    }
  }

  Future<bool> find(List<String> targets, {int durationMs = 300000}) => _write('local_find', targets, durationMs);
  Future<bool> off(List<String> targets) => _write('local_off', targets, 0);
  Future<bool> _write(String action, List<String> targets, int durationMs) async {
    if (_command == null || targets.isEmpty) return false;
    try {
      await _command!.write(utf8.encode(jsonEncode({'action': action, 'targets': targets, 'durationMs': durationMs})), withoutResponse: false);
      return true;
    } catch (_) { return false; }
  }

  Future<bool> _permissions() async {
    final states = await [Permission.bluetoothScan, Permission.bluetoothConnect].request();
    return states.values.every((state) => state.isGranted);
  }

  Future<void> disconnect() async {
    await _statusSub?.cancel();
    await _connectionSub?.cancel();
    try { await _device?.disconnect(); } catch (_) {}
    _device = null;
    _command = null;
  }

  void dispose() { disconnect(); _events.close(); }
}

class SessionGate extends StatefulWidget {
  const SessionGate({super.key});
  @override State<SessionGate> createState() => _SessionGateState();
}
class _SessionGateState extends State<SessionGate> {
  final _store = const FlutterSecureStorage();
  bool _loading = true;
  String? _token;
  @override
  void initState() { super.initState(); _restore(); }
  Future<void> _restore() async {
    final token = await _store.read(key: 'otkok_token');
    if (!mounted) return;
    setState(() { _token = token; _loading = false; });
  }
  @override
  Widget build(BuildContext context) {
    if (_loading) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (_token == null) return AuthScreen(onAuthenticated: (token) async { await _store.write(key: 'otkok_token', value: token); if (mounted) setState(() => _token = token); });
    return HomeScreen(token: _token!, onLogout: () async { await _store.delete(key: 'otkok_token'); if (mounted) setState(() => _token = null); });
  }
}

class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key, required this.onAuthenticated});
  final Future<void> Function(String token) onAuthenticated;
  @override State<AuthScreen> createState() => _AuthScreenState();
}
class _AuthScreenState extends State<AuthScreen> {
  final _email = TextEditingController(); final _password = TextEditingController(); final _name = TextEditingController();
  bool _signup = false; bool _busy = false;
  Future<void> _submit() async {
    setState(() => _busy = true);
    try {
      final result = await OtkokApi(null).call('/api/auth/${_signup ? 'signup' : 'login'}', method: 'POST', body: {'email': _email.text.trim(), 'password': _password.text, if (_signup) 'name': _name.text.trim()});
      await widget.onAuthenticated(result['token'].toString());
    } on ApiException catch (e) { if (mounted) _message(e.message); }
    finally { if (mounted) setState(() => _busy = false); }
  }
  void _message(String text) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  @override Widget build(BuildContext context) => Scaffold(
    body: SafeArea(child: Center(child: SingleChildScrollView(child: Padding(padding: const EdgeInsets.all(28), child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 420), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const Icon(Icons.auto_awesome, size: 56, color: Color(0xff2d63e5)), const SizedBox(height: 12), Text('옷콕', textAlign: TextAlign.center, style: Theme.of(context).textTheme.displaySmall?.copyWith(fontWeight: FontWeight.bold)),
      const SizedBox(height: 6), const Text('내 옷장과 가까운 기기를 빠르게 연결합니다.', textAlign: TextAlign.center), const SizedBox(height: 32),
      if (_signup) TextField(controller: _name, decoration: const InputDecoration(labelText: '이름 또는 사용자명', border: OutlineInputBorder())), if (_signup) const SizedBox(height: 12),
      TextField(controller: _email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: '이메일 또는 사용자명', border: OutlineInputBorder())), const SizedBox(height: 12),
      TextField(controller: _password, obscureText: true, decoration: const InputDecoration(labelText: '비밀번호', border: OutlineInputBorder())), const SizedBox(height: 20),
      FilledButton(onPressed: _busy ? null : _submit, child: Padding(padding: const EdgeInsets.all(14), child: Text(_busy ? '연결 중…' : (_signup ? '회원가입' : '로그인')))),
      TextButton(onPressed: _busy ? null : () => setState(() => _signup = !_signup), child: Text(_signup ? '이미 계정이 있습니다' : '처음이신가요? 회원가입')),
    ]))))))); 
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.token, required this.onLogout});
  final String token; final Future<void> Function() onLogout;
  @override State<HomeScreen> createState() => _HomeScreenState();
}
class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  late final OtkokApi _api = OtkokApi(widget.token); final GatewayBle _ble = GatewayBle();
  Map<String, dynamic>? _snapshot; Timer? _poll; bool _loading = true; bool _bleBusy = false; String _transport = '클라우드 연결됨';
  @override void initState() { super.initState(); WidgetsBinding.instance.addObserver(this); _ble.events.listen(_onBle); _refresh(); _poll = Timer.periodic(const Duration(milliseconds: 900), (_) => _refresh(silent: true)); }
  @override void dispose() { WidgetsBinding.instance.removeObserver(this); _poll?.cancel(); _ble.dispose(); super.dispose(); }
  @override void didChangeAppLifecycleState(AppLifecycleState state) { if (state == AppLifecycleState.resumed) { _refresh(); if (_ble.connected) _connectBle(silent: true); } }
  void _onBle(Map<String, dynamic> event) { if (!mounted) return; if (event['type'] == 'transport') setState(() => _transport = event['connected'] == true ? '근처 BLE 직통 연결됨' : '클라우드 연결됨'); if (event['type'] == 'status' || event['type'] == 'command_ack') _refresh(silent: true); }
  Future<void> _refresh({bool silent = false}) async { try { final data = await _api.call('/api/snapshot'); if (mounted) setState(() { _snapshot = Map<String, dynamic>.from(data as Map); _loading = false; }); } on ApiException catch (e) { if (!silent && mounted) _notice(e.message); } }
  Future<void> _connectBle({bool silent = false}) async { if (_bleBusy) return; setState(() => _bleBusy = true); final ok = await _ble.connect(); if (mounted) { setState(() { _bleBusy = false; _transport = ok ? '근처 BLE 직통 연결됨' : '클라우드 연결됨'; }); if (!ok && !silent) _notice('근처 옷봉을 찾지 못했습니다. 블루투스·옷봉 전원을 확인하세요.'); } }
  Future<void> _find(Map<String, dynamic> hanger) async { final id = hanger['hangerId'].toString(); bool done = false; if (_ble.connected) done = await _ble.find([id]); if (!done) { try { await _api.call('/api/commands', method: 'POST', body: {'command': 'LED_BLINK', 'targets': [id], 'durationMs': 300000}); } on ApiException catch (e) { if (mounted) _notice(e.message); return; } } if (mounted) _notice(done ? 'LED 찾기: 근처 BLE로 즉시 전송했습니다.' : 'LED 찾기: 클라우드 명령을 전송했습니다.'); }
  Future<void> _claim(Map<String, dynamic> item, String kind) async { final id = (kind == 'gateways' ? item['gatewayId'] : item['hangerId']).toString(); try { final intent = await _api.call('/api/$kind/${Uri.encodeComponent(id)}/claim-intent', method: 'POST'); await _api.call('/api/$kind/${Uri.encodeComponent(id)}/claim', method: 'POST', body: {'claimToken': intent['claimToken']}); await _refresh(); if (mounted) _notice(kind == 'gateways' ? '옷봉이 등록되었습니다.' : '옷걸이가 등록되어 자동 페어링되었습니다.'); } on ApiException catch (e) { if (mounted) _notice(e.message); } }
  void _notice(String message) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  List<Map<String, dynamic>> _list(String name) => ((_snapshot?[name] as List?) ?? const []).map((e) => Map<String, dynamic>.from(e as Map)).toList();
  @override Widget build(BuildContext context) {
    final hangers = _list('hangers'); final gateways = _list('gateways'); final discovered = _list('discoveredHangers');
    return Scaffold(appBar: AppBar(title: const Text('옷콕'), actions: [TextButton.icon(onPressed: _bleBusy ? null : _connectBle, icon: Icon(_ble.connected ? Icons.bluetooth_connected : Icons.bluetooth), label: Text(_bleBusy ? '연결 중' : _transport, overflow: TextOverflow.ellipsis)), IconButton(onPressed: widget.onLogout, icon: const Icon(Icons.logout), tooltip: '로그아웃')]),
      floatingActionButton: FloatingActionButton.extended(onPressed: _refresh, icon: const Icon(Icons.refresh), label: const Text('새로고침')),
      body: _loading ? const Center(child: CircularProgressIndicator()) : RefreshIndicator(onRefresh: _refresh, child: ListView(padding: const EdgeInsets.all(16), children: [
        _StatusCard(gatewayCount: gateways.length, hangerCount: hangers.length, transport: _transport), const SizedBox(height: 18),
        Row(children: [Text('내 스마트 옷걸이', style: Theme.of(context).textTheme.titleLarge), const Spacer(), Text('${hangers.length}개')]), const SizedBox(height: 8),
        if (hangers.isEmpty) const Card(child: Padding(padding: EdgeInsets.all(20), child: Text('등록된 옷걸이가 없습니다. 아래 감지된 장비에서 등록하세요.'))),
        ...hangers.map((hanger) => _HangerCard(hanger: hanger, onFind: () => _find(hanger))),
        const SizedBox(height: 18), Text('감지된 장비 등록', style: Theme.of(context).textTheme.titleLarge), const SizedBox(height: 8),
        ...gateways.where((e) => e['wardrobeId'] == null).map((item) => _ClaimCard(label: '옷봉', id: item['gatewayId'].toString(), onClaim: () => _claim(item, 'gateways'))),
        ...discovered.map((item) => _ClaimCard(label: '새 옷걸이', id: item['hangerId'].toString(), onClaim: () => _claim(item, 'hangers'))),
        if (gateways.where((e) => e['wardrobeId'] == null).isEmpty && discovered.isEmpty) const Card(child: Padding(padding: EdgeInsets.all(20), child: Text('새 장비 신호를 기다리고 있습니다. 옷봉을 먼저 등록한 뒤 옷걸이 전원을 켜세요.'))),
      ])),
    );
  }
}

class _StatusCard extends StatelessWidget { const _StatusCard({required this.gatewayCount, required this.hangerCount, required this.transport}); final int gatewayCount, hangerCount; final String transport; @override Widget build(BuildContext context) => Card(color: const Color(0xffeef4ff), child: Padding(padding: const EdgeInsets.all(18), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(transport, style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xff1857bd))), const SizedBox(height: 8), Text('등록 옷봉 $gatewayCount개 · 등록 옷걸이 $hangerCount개')]))); }
class _HangerCard extends StatelessWidget { const _HangerCard({required this.hanger, required this.onFind}); final Map<String,dynamic> hanger; final VoidCallback onFind; @override Widget build(BuildContext context) { final online = hanger['state'] != 'OFFLINE'; final state = hanger['state'] == 'IN_WARDROBE' ? '옷장 안' : hanger['state'] == 'OUT' ? '옷장 밖' : (hanger['state']?.toString() ?? '상태 확인 중'); return Card(child: Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Row(children: [Icon(Icons.checkroom, color: online ? Colors.green : Colors.grey), const SizedBox(width: 8), Expanded(child: Text(hanger['customName']?.toString().isNotEmpty == true ? hanger['customName'].toString() : hanger['alias']?.toString() ?? '스마트 옷걸이', style: Theme.of(context).textTheme.titleMedium)), Chip(label: Text(online ? state : '오프라인'))]), const SizedBox(height: 6), Text(hanger['hangerId']?.toString() ?? ''), const SizedBox(height: 12), FilledButton.icon(onPressed: online ? onFind : null, icon: const Icon(Icons.lightbulb_outline), label: const Text('LED 찾기'))]))); } }
class _ClaimCard extends StatelessWidget { const _ClaimCard({required this.label, required this.id, required this.onClaim}); final String label,id; final VoidCallback onClaim; @override Widget build(BuildContext context) => Card(child: ListTile(leading: const Icon(Icons.sensors), title: Text('$label · $id'), subtitle: const Text('내 계정에만 등록됩니다.'), trailing: FilledButton(onPressed: onClaim, child: const Text('등록')))); }
