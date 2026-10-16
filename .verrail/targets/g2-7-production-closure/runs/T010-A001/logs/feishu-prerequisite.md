# Feishu Acceptance Prerequisite

- User-selected application: `cli_a94a4cb0bafadcd4` (息壤).
- Source: the user's application URL and the authenticated developer console.
- Observed on 2026-09-05: the application is enabled and published in Feishu Personal Edition.
- Event transport: long connection. The existing `im.message.receive_v1` subscription is enabled.
- The repository's current connector implements signed/encrypted Webhook ingress, not long-connection ingress.
- No application settings, permissions, transport, or publication state have been changed in this run.
- No App Secret, token, or encryption key has been retrieved or copied into evidence.

## Pending Decisions

- Preserve the application's existing long-connection configuration and add compatible transport support, or authorize switching this application to a Verrail test Webhook. Switching may interrupt its existing receiver.
- Confirm that the user's direct conversation with this bot is the intended destination for clearly labeled G2.7 test messages.

This is prerequisite inspection, not evidence of successful provider ingress, reply delivery, or Target creation.
