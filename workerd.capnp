# dropbin on workerd: the whole deployment in one file.
#
#   ACCESS_PASSWORD=… S3_ENDPOINT=http://127.0.0.1:3900 S3_BUCKET=dropbin \
#   S3_KEY_ID=… S3_SECRET=… npx workerd serve workerd.capnp
#
# Secrets and the storage endpoint come from the environment; the three tunables
# below are plain text. Any S3 server works (path-style). The socket honours
# X-Forwarded-Proto, so behind a TLS-terminating proxy the links it builds say
# https. To run it next to other workers in one process, import `dropbin` from
# another config: `using D = import "dropbin/workerd.capnp";` then `worker = D.dropbin`.

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "dropbin", worker = .dropbin),
    # tlsOptions: without a CA list workerd trusts nothing, and an https:// S3 endpoint fails every request.
    (name = "storage", network = (allow = ["public", "private"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [
    (name = "http", address = "*:8787", service = "dropbin",
     http = (forwardedProtoHeader = "X-Forwarded-Proto")),
  ],
);

const dropbin :Workerd.Worker = (
  compatibilityDate = "2025-01-01",
  modules = [
    (name = "src/index.js", esModule = embed "src/index.js"),
    (name = "src/util.js", esModule = embed "src/util.js"),
    (name = "src/ui.js", esModule = embed "src/ui.js"),
    (name = "src/s3.js", esModule = embed "src/s3.js"),
    # Served as strings, with __HOST__ swapped for the request origin.
    (name = "src/drop.sh", text = embed "src/drop.sh"),
    (name = "src/drop.ps1", text = embed "src/drop.ps1"),
    (name = "install.sh", text = embed "install.sh"),
    (name = "install.ps1", text = embed "install.ps1"),
  ],
  bindings = [
    (name = "ACCESS_PASSWORD", fromEnvironment = "ACCESS_PASSWORD"),
    (name = "S3_ENDPOINT", fromEnvironment = "S3_ENDPOINT"),
    (name = "S3_BUCKET", fromEnvironment = "S3_BUCKET"),
    (name = "S3_REGION", fromEnvironment = "S3_REGION"),
    (name = "S3_KEY_ID", fromEnvironment = "S3_KEY_ID"),
    (name = "S3_SECRET", fromEnvironment = "S3_SECRET"),
    # What the storage meter counts down from.
    (name = "QUOTA_GB", text = "10"),
    # Ceiling for zipping an old multi-file pin on the way out (built in memory).
    (name = "ZIP_LIMIT_MB", text = "64"),
    # The longest a `db open` / `db qr` share link may be signed for.
    (name = "SHARE_HOURS", text = "720"),
  ],
  # Reaches the S3 endpoint, which is usually on a private address. dropbin
  # fetches nothing else, and never a URL a visitor supplies.
  globalOutbound = "storage",
);
