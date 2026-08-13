# a2wave CLI

The official command-line client for [a2wave](https://github.com/LilithGames/a2wave), a natural-language-driven Agent building and orchestration platform.

The package installs the `a2wave` command.

## Requirements

- Node.js 22 or later
- An a2wave instance for platform-management commands
- Docker with Compose support when using `a2wave setup`

## Install

```bash
npm install --global a2wave
```

Verify the installation:

```bash
a2wave --version
a2wave --help
```

## Get started

Sign in, configure the instance URL, and check connectivity:

```bash
a2wave login
a2wave config set-url https://a2wave.example.com
a2wave status
```

Then manage resources or invoke an Agent:

```bash
a2wave agents list
a2wave skills list
a2wave chat send my-agent --message "Hello"
```

Use `a2wave <command> --help` for command-specific options.

## Local platform setup

The CLI can create and manage a Docker-based local deployment. It defaults to the
published GHCR image matching the CLI's own version:

```bash
a2wave setup
```

To bundle a PostgreSQL 16 sidecar instead of using the default SQLite database:

```bash
a2wave setup --with-postgres
```

PostgreSQL support is experimental and starts from an empty database; there is no
SQLite-to-PostgreSQL data migration path. Use `--image` only for a locally built or
mirrored image reference.

Every generated deployment also mounts a dedicated `a2wave-workspace` volume at
`/data/workspace`. The web UI allocates Git checkout paths there automatically;
users do not need to enter the container or create directories. P4 sources use
an explicit operator-mounted path covered by the Client `Root` or `AltRoots`.

The PostgreSQL setup flags were added after CLI v0.7.2 and are not present in the
published `a2wave@0.7.2` package. Confirm that `a2wave setup --help` lists
`--with-postgres` before using it.

Run `a2wave setup --help` before installation to review directory, port, upgrade, backup, and removal options.

## Documentation and support

- [CLI installation and publishing guide](https://github.com/LilithGames/a2wave/blob/main/docs/agent/cli-install-publish.md)
- [Project documentation](https://github.com/LilithGames/a2wave#readme)
- [Issue tracker](https://github.com/LilithGames/a2wave/issues)
- [Security policy](https://github.com/LilithGames/a2wave/security/policy)

## License

Apache License 2.0. See the `LICENSE` and `NOTICE` files included in this package.
