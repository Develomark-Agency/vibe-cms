/**
 * Sending email: `email` in `createHandler`'s bindings, any object with a `send` method. The CMS writes
 * its messages (invites, for now) and the sender delivers them. Without one, the editor shows links to copy.
 */

export interface EmailMessage {
  to: string,
  subject: string,
  text: string,
  html?: string
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}
