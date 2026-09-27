import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  ServerConfigError,
  isAllowedHostHeader,
  isLoopbackHost,
  loadServerConfig,
  validateOrigins,
} from "./env.js";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");
const envExample = readFileSync(path.join(repoRoot, ".env.example"), "utf8");

const load = (env: NodeJS.ProcessEnv) =>
  loadServerConfig({ env, workspaceRoot: repoRoot });

// npm runs a workspace script with cwd set to that workspace, so a repo-root
// .env is one level up. Getting this wrong boots the server with no
// configuration and a warning nobody reads.
describe("env file resolution", () => {
  const serverPkg = JSON.parse(
    readFileSync(path.join(repoRoot, "server", "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };

  it("points the server env file at the repository root", () => {
    for (const script of ["dev", "probe"]) {
      const command = serverPkg.scripts[script];
      assert.ok(command, `server script ${script} must exist`);
      const match = /--env-file-if-exists=(\S+)/.exec(command);
      assert.ok(match, `${script} must load the env file`);
      const resolved = path.resolve(repoRoot, "server", match[1]);
      assert.equal(
        resolved,
        path.join(repoRoot, ".env"),
        `${script} must resolve to the repo-root .env from the server workspace`,
      );
    }
  });

  it("declares the Node floor that introduced --env-file-if-exists", () => {
    const rootPkg = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { engines?: { node?: string } };
    // --env-file-if-exists landed in Node 22.9.0.
    assert.equal(rootPkg.engines?.node, ">=22.9.0");
  });
});

describe("origin validation helper", () => {
  it("accepts exact origins and rejects everything else", () => {
    assert.deepEqual(validateOrigins(["http://a.test", "https://b.test:8443"]), [
      "http://a.test",
      "https://b.test:8443",
    ]);
    assert.throws(() => validateOrigins(["nope"]), ServerConfigError);
  });
});

describe("server config", () => {
  it("defaults to loopback 8787 and resolves the injected workspace root", () => {
    const config = load({});
    assert.equal(config.port, 8787);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.allowRemote, false);
    assert.equal(config.workspaceRoot, repoRoot);
    assert.equal(config.acpCommand, undefined);
    assert.equal(config.allowedOrigins, null);
    assert.equal(config.disableLiveSeats, false);
  });

  it("refuses a remote bind unless ALLOW_REMOTE is exactly true", () => {
    assert.throws(
      () => load({ HOST: "0.0.0.0" }),
      (err: unknown) =>
        err instanceof ServerConfigError &&
        err.message === "remote HOST requires ALLOW_REMOTE=true",
    );
    // A remote bind also needs an explicit Host allowlist; see the next test.
    assert.throws(() => load({ HOST: "0.0.0.0", ALLOW_REMOTE: "true" }), ServerConfigError);
    assert.equal(
      load({ HOST: "0.0.0.0", ALLOW_REMOTE: "true", K5_ALLOWED_HOSTS: "t.test" }).allowRemote,
      true,
    );
    // Anything but the exact string stays refused, so "1"/"yes" cannot enable it.
    assert.throws(() => load({ HOST: "0.0.0.0", ALLOW_REMOTE: "1" }), ServerConfigError);
  });

  it("reports the bind refusal before any origin problem", () => {
    assert.throws(
      () => load({ HOST: "10.0.0.5", K5_ALLOWED_ORIGINS: "" }),
      (err: unknown) => err instanceof ServerConfigError && /ALLOW_REMOTE/.test(err.message),
    );
  });

  it("rejects a non-integer or out-of-range port", () => {
    for (const PORT of ["0", "65536", "abc", "80.5", "-1"]) {
      assert.throws(() => load({ PORT }), ServerConfigError, `PORT=${PORT}`);
    }
    assert.equal(load({ PORT: "9000" }).port, 9000);
  });

  it("derives loopback allowed hosts and honours explicit extras", () => {
    const config = load({});
    assert.deepEqual(config.allowedHosts, ["127.0.0.1", "localhost", "::1"]);
    const extra = load({ K5_ALLOWED_HOSTS: "tunnel.example , other.test" });
    assert.ok(extra.allowedHosts.includes("tunnel.example"));
    assert.ok(extra.allowedHosts.includes("other.test"));
  });

  it("refuses a remote bind with no Host allowlist at all", () => {
    assert.throws(
      () => load({ HOST: "0.0.0.0", ALLOW_REMOTE: "true" }),
      (err: unknown) => err instanceof ServerConfigError && /K5_ALLOWED_HOSTS/.test(err.message),
    );
    assert.equal(
      load({ HOST: "0.0.0.0", ALLOW_REMOTE: "true", K5_ALLOWED_HOSTS: "tunnel.example" }).host,
      "0.0.0.0",
    );
  });

  it("refuses a Host header that is absent, blank, or unlisted", () => {
    const config = load({});
    assert.equal(isAllowedHostHeader(undefined, config), false);
    assert.equal(isAllowedHostHeader("", config), false);
    assert.equal(isAllowedHostHeader("   ", config), false);
    assert.equal(isAllowedHostHeader("evil.example:8787", config), false);
    assert.equal(isAllowedHostHeader("evil.example", config), false);
    // A loopback name is accepted on any port: a rebinding browser sends its
    // own name as Host, so the hostname is the security boundary, not the port.
    assert.equal(isAllowedHostHeader("127.0.0.1:9999", config), true);
    assert.equal(isAllowedHostHeader("127.0.0.1", config), true);
    assert.equal(isAllowedHostHeader("LOCALHOST:8787", config), true);
    assert.equal(isAllowedHostHeader("[::1]:8787", config), true);
  });

  it("lets an explicit entry pin host:port exactly", () => {
    const config = load({ K5_ALLOWED_HOSTS: "tunnel.example:8443" });
    assert.equal(isAllowedHostHeader("tunnel.example:8443", config), true);
    assert.equal(isAllowedHostHeader("tunnel.example:9999", config), false);
    assert.equal(isAllowedHostHeader("tunnel.example", config), false);
  });

  it("parses the origin allowlist and trims blanks", () => {
    const config = load({
      K5_ALLOWED_ORIGINS: " http://127.0.0.1:5173 , ,http://localhost:5173 ",
    });
    assert.deepEqual(config.allowedOrigins, [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ]);
  });

  it("rejects an allowlist entry that is not an exact origin", () => {
    // Origins are compared as exact strings, so a near-miss entry would 403
    // every real browser while looking correctly configured.
    for (const entry of [
      "http://127.0.0.1:5173/", // trailing slash
      "HTTP://127.0.0.1:5173", // scheme case
      "127.0.0.1:5173", // no scheme
      "*", // wildcard is not matched by exact comparison
      "http://127.0.0.1:5173/path",
      "http://user:pw@127.0.0.1:5173",
    ]) {
      assert.throws(
        () => load({ K5_ALLOWED_ORIGINS: entry }),
        (err: unknown) =>
          err instanceof ServerConfigError && /not exact origins/.test(err.message),
        `must reject ${entry}`,
      );
    }
  });

  it("names the offending entry so a typo is diagnosable", () => {
    assert.throws(
      () => load({ K5_ALLOWED_ORIGINS: "http://127.0.0.1:5173,127.0.0.1:9999" }),
      (err: unknown) => err instanceof ServerConfigError && err.message.includes("127.0.0.1:9999"),
    );
  });

  it("accepts a well-formed https origin with a path-free URL", () => {
    assert.deepEqual(
      load({ K5_ALLOWED_ORIGINS: "https://tunnel.example" }).allowedOrigins,
      ["https://tunnel.example"],
    );
  });

  it("treats a blank ACP_COMMAND as unset rather than an empty command", () => {
    assert.equal(load({ ACP_COMMAND: "   " }).acpCommand, undefined);
    assert.equal(load({ ACP_COMMAND: " opencode acp " }).acpCommand, "opencode acp");
  });

  it("classifies loopback hosts without trusting a name suffix", () => {
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("127.5.5.5"), true);
    assert.equal(isLoopbackHost("::1"), true);
    assert.equal(isLoopbackHost("[::1]"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("0.0.0.0"), false);
    assert.equal(isLoopbackHost("10.0.0.1"), false);
    assert.equal(isLoopbackHost("localhost.evil.com"), false);
  });
});

// The documented env contract and the code that reads it must not drift: a
// missing key here is a runtime failure a day later, not a compile error.
describe("documented env contract", () => {
  const required = [
    "ACP_COMMAND",
    "PORT",
    "HOST",
    "ALLOW_REMOTE",
    "K5_SERVER_ORIGIN",
    "K5_ALLOWED_ORIGINS",
  ] as const;

  for (const key of required) {
    it(`documents ${key}`, () => {
      assert.match(
        envExample,
        new RegExp(`^${key}=`, "m"),
        `${key} must appear in .env.example`,
      );
    });
  }

  it("advertises no dead keys", () => {
    // K5_PREVIEW_ORIGIN was removed: the preview origin belongs in the gateway
    // allowlist, and documenting a variable nothing reads is a lie.
    for (const dead of ["WORKSPACE_DIR", "MODEL_BASE_URL", "MODEL_API_KEY", "SLACK_BOT_TOKEN", "NOTION_API_KEY", "LINEAR_API_KEY", "JIRA_API_KEY", "K5_PREVIEW_ORIGIN"]) {
      assert.doesNotMatch(
        envExample,
        new RegExp(`^${dead}=`, "m"),
        `${dead} is not read by any code and must not be documented`,
      );
    }
  });

  it("keeps the proxy target host/port in agreement with the server bind", () => {
    const origin = /K5_SERVER_ORIGIN=(\S+)/.exec(envExample)?.[1];
    assert.ok(origin, "K5_SERVER_ORIGIN must be set");
    const url = new URL(origin);
    const port = /PORT=(\d+)/.exec(envExample)?.[1];
    const host = /HOST=(\S+)/.exec(envExample)?.[1];
    assert.equal(url.port, port, "proxy target port must match PORT");
    assert.equal(url.hostname, host, "proxy target host must match HOST");
  });

  it("lists both dev origins and the preview origin in the allowlist", () => {
    const allow = /K5_ALLOWED_ORIGINS=(.+)/.exec(envExample)?.[1] ?? "";
    const listed = allow.split(",").map((o) => o.trim());
    const preview = /:4173$/.test(listed[listed.length - 1] ?? "") ? "http://127.0.0.1:4173" : null;
    assert.ok(preview, "allowlist must end with the vite preview origin");
    for (const expected of [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      preview,
    ]) {
      assert.ok(listed.includes(expected), `allowlist must include ${expected}`);
    }
  });
});
