// build.zig — produces the native CLI for each {os, arch}.
//
// Build for the host:        zig build
// Cross-compile a release:   zig build -Dtarget=x86_64-windows -Doptimize=ReleaseSafe
//                            zig build -Dtarget=aarch64-macos  -Doptimize=ReleaseSafe
//
// Targets the npm package expects under native/<platform>-<arch>/:
//   x86_64-linux, aarch64-linux, x86_64-macos, aarch64-macos,
//   x86_64-windows, aarch64-windows
//
// NOTE: tested to be structurally idiomatic for Zig 0.13/0.14. Some std API
// names drift between Zig releases; pin your toolchain in CI (see workflow).
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSafe });

    const exe = b.addExecutable(.{
        .name = "codex-accounts",
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    if (b.args) |args| run_cmd.addArgs(args);
    const run_step = b.step("run", "Run the CLI");
    run_step.dependOn(&run_cmd.step);

    const unit_tests = b.addTest(.{
        .root_source_file = b.path("src/security.zig"),
        .target = target,
        .optimize = optimize,
    });
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&b.addRunArtifact(unit_tests).step);
}
