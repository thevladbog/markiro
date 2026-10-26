import { rehearsalImages, rehearsalLabel } from "../upgrade-ci-guards.mjs";
const invocationId = "12345678-1234-4234-8234-123456789012";
const name = `markiro-upgrade-ci-${invocationId}`;
export function rehearsalFixture() {
  const volume = {
    Name: name,
    Driver: "local",
    Options: {},
    Labels: { [rehearsalLabel]: invocationId },
    CreatedAt: "2026-10-24T00:00:00Z",
    Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
  };
  const container = {
    Id: "a".repeat(64),
    Name: `/${name}`,
    Image: rehearsalImages.daemonId,
    Config: { Labels: { [rehearsalLabel]: invocationId } },
    State: { Running: true, Paused: false, Restarting: false },
    HostConfig: {
      Privileged: true,
      Binds: null,
      PortBindings: {},
      NetworkMode: "bridge",
      PidMode: "",
      IpcMode: "private",
    },
    Mounts: [
      {
        Type: "volume",
        Name: name,
        Source: volume.Mountpoint,
        Destination: "/var/lib/docker",
        RW: true,
      },
    ],
    NetworkSettings: { Networks: {}, Ports: {} },
  };
  return { invocationId, container, volume, routes: { ipv4: "", ipv6: "" } };
}
