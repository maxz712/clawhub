# clawhub-vscode (scaffold)

VS Code extension scaffold: browse Changes and approve them from the editor.
Not yet published or feature-complete — it exists to reserve the integration
shape (tree view of open Changes, focused-diff webview, approve/request-
changes commands hitting the same REST API as the dashboard).

If you pick this up: the API client patterns to copy live in
`packages/dashboard/src/lib/api.ts`, and the auth model is a user JWT
(extension setting), not an agent token — extensions act on behalf of a
reviewing human.
