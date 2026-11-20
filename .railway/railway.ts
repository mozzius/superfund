// Railway infrastructure for the superfund project (production).
//
// Railway doesn't read this file on deploy: after changing it, run
// `railway config plan` to preview and `railway config apply` to push it.
// Pushes to main still autodeploy each service from GitHub as usual.
//
// Variables are unmanaged: IaC never reads or writes them, so secrets and
// per-service env stay in the Railway dashboard / `railway variable`.
import { defineRailway, github, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const superfund = github("mozzius/superfund", { branch: "main", checkSuites: false });
  const region = "europe-west4-drams3a";
  const volumeDefaults = {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region,
  };

  const labellerVolume = volume("labeller-volume", { ...volumeDefaults, sizeMB: 30000 });
  const ingesterVolume = volume("ingester-volume", { ...volumeDefaults, sizeMB: 50000 });
  const followsAuditVolume = volume("follows-audit-volume", { ...volumeDefaults, sizeMB: 50000 });

  // Railway bills cgroup memory, which includes page cache over the SQLite
  // files on each volume, so every service gets an explicit memory cap.
  const labeller = service("labeller", {
    source: superfund,
    build: {
      buildEnvironment: "V3",
      builder: "RAILPACK",
      watchPatterns: ["/apps/labeller/**", "/packages/labeller-client/**", "/pnpm-lock.yaml"],
    },
    start: "pnpm -F labeller start",
    healthcheck: "/xrpc/_health",
    healthcheckTimeout: 1200,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      drainingSeconds: 15,
      limitOverride: { containers: { memoryBytes: 1_000_000_000 } },
    },
    replicas: { [region]: 1 },
    domains: [{ domain: "tools.mozzius.dev", port: 14831 }],
    volumeMounts: { "/data": labellerVolume },
  });

  const ingester = service("ingester", {
    source: superfund,
    build: {
      buildEnvironment: "V3",
      builder: "RAILPACK",
      watchPatterns: ["/apps/ingester/**", "/packages/labeller-client/**", "/pnpm-lock.yaml"],
    },
    start: "pnpm -F ingester start",
    deploy: {
      restartPolicyType: "ON_FAILURE",
      limitOverride: { containers: { memoryBytes: 500_000_000 } },
    },
    replicas: { [region]: 1 },
    volumeMounts: { "/data": ingesterVolume },
  });

  // Private only: the labeller dashboard reads it at
  // http://follows-audit.railway.internal:14833 (PORT is set to 14833).
  const followsAudit = service("follows-audit", {
    source: superfund,
    build: {
      buildEnvironment: "V3",
      builder: "RAILPACK",
      watchPatterns: ["/apps/follows-audit/**", "/packages/labeller-client/**", "/pnpm-lock.yaml"],
    },
    start: "pnpm -F follows-audit start",
    healthcheck: "/health",
    healthcheckTimeout: 120,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      limitOverride: { containers: { memoryBytes: 500_000_000 } },
    },
    replicas: { [region]: 1 },
    volumeMounts: { "/data": followsAuditVolume },
  });

  return project("superfund", {
    variables: { managed: false },
    resources: [labeller, ingester, followsAudit, labellerVolume, ingesterVolume, followsAuditVolume],
  });
});
