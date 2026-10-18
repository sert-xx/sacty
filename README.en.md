[日本語](README.md) | **English**

# sacty

An AI software factory. sacty takes in tasks, the orchestrator and the goal guardian move them through the steps,
and humans make decisions only at the approval gates.

## Quick start

You need macOS, Node.js 22.13 or later, Docker, and the GitHub CLI (`gh`).

```sh
npm install
npm run build
npx sacty config init   # creates ~/.sacty/config.yaml (set the AI, auth mode, and unit prices)
npx sacty secret set claude-oauth-token   # stores the token for the template's AI (a Claude Code subscription), created with claude setup-token
npx sacty image build   # builds the container image for running agents (if you cannot use public registries, write image_build in config.yaml first)
npx sacty up            # starts the daemon and the web UI, and prints the sign-in URL http://127.0.0.1:4700/auth?token=… (open it in your browser)
```

See [Getting started](docs/user/getting-started.en.md) for the detailed steps.

## Documentation

- [User documentation](docs/user/README.en.md): settings, commands, and usage (find the page you need from the contents)
- [Docs overview](docs/README.md): how all the documentation is organized, including the specifications, ADRs, and work logs (in Japanese)

## Contributing and security

- [How to contribute](CONTRIBUTING.md): development environment, the flow of a change, and what to check before opening a PR (in Japanese)
- [Security](SECURITY.md): how to report a vulnerability (in Japanese)

## License

[MIT](LICENSE)
