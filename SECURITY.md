# Security Policy

Please report vulnerabilities privately through GitHub Security Advisories instead of opening a public issue.

The proxy listens on `127.0.0.1` by default. Binding to another interface can expose model access and agent traffic to the network. Use authentication, TLS, firewall rules, and a trusted reverse proxy before doing so.

Never commit API keys, generated Codex homes, logs, sessions, or checkpoints. Pass upstream credentials through `LLAMA_API_KEY`.
