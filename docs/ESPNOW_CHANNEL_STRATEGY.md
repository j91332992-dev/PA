# Channel strategy

Gateway sequence: join home Wi-Fi, read AP channel, initialize ESP-NOW on that channel, broadcast beacon periodically. Hanger stores last good channel in NVS, searches it for beacon, then sweeps supported 2.4 GHz channels until beacon is found and persists that channel.

Do not claim recovery time before test. Test AP channel change, restart, rediscovery, mean/max time and failure rate. `REQUIRES_PHYSICAL_TEST`.
