# Public deployment

Use a managed Node host with persistent storage/managed database, HTTPS and a WSS-capable reverse proxy. Set `PORT`, `PUBLIC_ORIGIN`, `DEVICE_TOKEN`, `JWT_SECRET` as host secrets; do not use the local JSON store for multi-instance production. Point gateway HTTPS/MQTT endpoint to the public domain and test from phone LTE. A public URL was not provisioned by this repository. `REQUIRES_PHYSICAL_TEST`.
