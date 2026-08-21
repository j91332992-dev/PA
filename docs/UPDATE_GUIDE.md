# Update and recovery guide

Back up `data/wardrobe.json` before backend changes. Version API/protocol changes compatibly; deploy backend/web atomically and retain a previous release for rollback. Update hangers by USB in V1; gateway Wi-Fi OTA is a planned integration after signed image/update-server selection. Never commit `.env`, Wi-Fi, broker, DB, device-token or JWT secrets. Test rollback and gateway rejoin after every release. `REQUIRES_PHYSICAL_TEST` for firmware OTA.
