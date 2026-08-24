// Development and test builds resolve the workspace package here. The server
// build replaces this compiled shim with the package's built distribution, so
// published server installs do not require a separate private runner package.
// Keep runtime behavior in the package; this file is only the build boundary.
export * from "@paperclipai/paperclip-runner";
