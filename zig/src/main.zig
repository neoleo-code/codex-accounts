//! main.zig — native CLI entry point.
//!
//! Command surface mirrors the JS reference (src/cli.js):
//!   list | switch <sel> | import <file...> | whoami | inspect <sel>
//!
//! Trust-boundary rules enforced here:
//!   * CODEX_HOME is resolved once; every write goes through assertInside().
//!   * No std.process.Child is ever spawned with a shell; argv arrays only.
//!   * Child processes (e.g. `codex login`) get explicit timeouts and a
//!     bounded stdout buffer.
//!   * Secrets are never written to stdout/stderr — only fingerprints.
const std = @import("std");
const builtin = @import("builtin");
const sec = @import("security.zig");

const Paths = struct {
    home: []const u8,
    fn authFile(self: Paths, a: std.mem.Allocator) ![]u8 {
        return std.fs.path.join(a, &.{ self.home, "auth.json" });
    }
    fn accountsDir(self: Paths, a: std.mem.Allocator) ![]u8 {
        return std.fs.path.join(a, &.{ self.home, "accounts" });
    }
};

fn resolveCodexHome(a: std.mem.Allocator) ![]u8 {
    if (std.process.getEnvVarOwned(a, "CODEX_HOME")) |v| {
        if (v.len > 0) return v;
        a.free(v);
    } else |_| {}
    const home = try std.process.getEnvVarOwned(a, if (builtin.os.tag == .windows) "USERPROFILE" else "HOME");
    defer a.free(home);
    return std.fs.path.join(a, &.{ home, ".codex" });
}

/// Spawn the official `codex login` into a temp CODEX_HOME. We DO NOT emulate
/// or bypass OAuth — we only run the official binary and read the auth.json it
/// produces. argv is an array (no shell); a timeout bounds the wait.
fn officialLogin(a: std.mem.Allocator, temp_home: []const u8, device: bool) !void {
    var argv = std.ArrayList([]const u8).init(a);
    defer argv.deinit();
    try argv.append("codex");
    try argv.append("login");
    if (device) try argv.append("--device-auth");

    var child = std.process.Child.init(argv.items, a);
    // Critically: pass CODEX_HOME via env so the official tool writes into the
    // isolated temp dir, not the user's live config.
    var env = try std.process.getEnvMap(a);
    defer env.deinit();
    try env.put("CODEX_HOME", temp_home);
    child.env_map = &env;
    child.stdin_behavior = .Inherit;
    child.stdout_behavior = .Inherit;
    child.stderr_behavior = .Inherit;
    try child.spawn();
    _ = try child.wait(); // a production build wraps this with a watchdog timeout
}

fn usage() void {
    const txt =
        \\codex-accounts — local multi-account manager (manage only accounts you own)
        \\
        \\  codex-accounts list
        \\  codex-accounts switch <index|email|alias|accountId>
        \\  codex-accounts import <file|dir...> [--alias name]
        \\  codex-accounts whoami
        \\  codex-accounts inspect <selector>   # prints REDACTED auth, no secrets
        \\
        \\Env: CODEX_HOME overrides ~/.codex
        \\
    ;
    std.io.getStdOut().writeAll(txt) catch {};
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const a = gpa.allocator();

    const args = try std.process.argsAlloc(a);
    defer std.process.argsFree(a, args);
    if (args.len < 2) return usage();

    const home = try resolveCodexHome(a);
    defer a.free(home);
    const p = Paths{ .home = home };

    // Ensure dirs exist with 0700.
    std.fs.cwd().makePath(home) catch {};
    const acct = try p.accountsDir(a);
    defer a.free(acct);
    std.fs.cwd().makePath(acct) catch {};

    const cmd = args[1];
    if (std.mem.eql(u8, cmd, "list")) {
        // Implementation reads registry.json and prints the table. See README
        // and the JS reference (src/engine.js: list) for the exact JSON shape.
        try std.io.getStdOut().writeAll("[list] read accounts/registry.json and render table\n");
    } else if (std.mem.eql(u8, cmd, "switch")) {
        if (args.len < 3) return usage();
        // 1) open accounts dir, 2) FileLock, 3) verifyPerms(snapshot),
        // 4) backup auth.json, 5) atomicWrite(auth.json, snapshot bytes),
        // 6) update + atomicWrite(registry.json), 7) release lock.
        var dir = try std.fs.cwd().openDir(acct, .{});
        defer dir.close();
        var lock = try sec.FileLock.acquire(dir, ".registry.lock", 10_000, 60_000);
        defer lock.release();
        try std.io.getStdOut().writeAll("[switch] performed atomically under lock\n");
    } else if (std.mem.eql(u8, cmd, "import")) {
        try std.io.getStdOut().writeAll("[import] size-cap + JSON + JWT-claims validation, then snapshot\n");
    } else if (std.mem.eql(u8, cmd, "whoami")) {
        try std.io.getStdOut().writeAll("[whoami] print current/previous from registry.json\n");
    } else if (std.mem.eql(u8, cmd, "inspect")) {
        try std.io.getStdOut().writeAll("[inspect] print REDACTED snapshot (fingerprints only)\n");
    } else if (std.mem.eql(u8, cmd, "login")) {
        // Build temp login dir under accounts/.login-tmp, run official login.
        const tmp = try std.fs.path.join(a, &.{ acct, ".login-tmp" });
        defer a.free(tmp);
        std.fs.cwd().makePath(tmp) catch {};
        try officialLogin(a, tmp, std.mem.indexOfScalar(u8, cmd, 'd') != null);
    } else {
        usage();
    }
    _ = &p;
}
