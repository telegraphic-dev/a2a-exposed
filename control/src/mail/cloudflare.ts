import type { Mailer, OutboundMail } from "./types.ts";

interface SendEmailBinding {
	send(message: EmailMessage): Promise<void>;
}

function headerValue(value: string): string {
	if (/[\r\n]/.test(value)) throw new Error("mail header contains a line break");
	return value;
}

function rawMessage(from: string, message: OutboundMail): string {
	const subject = headerValue(message.subject);
	if (!/^[\t\x20-\x7e]*$/.test(subject)) throw new Error("mail subject must be ASCII");
	return [
		`From: ${headerValue(from)}`,
		`To: ${headerValue(message.to)}`,
		`Subject: ${subject}`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: 8bit",
		"",
		message.text.replace(/\r?\n/g, "\r\n"),
	].join("\r\n");
}

export function cloudflareMailer(binding: SendEmailBinding, from: string): Mailer {
	return {
		async send(message) {
			const { EmailMessage } = await import("cloudflare:email");
			await binding.send(new EmailMessage(headerValue(from), headerValue(message.to), rawMessage(from, message)));
		},
	};
}
