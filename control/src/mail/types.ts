export interface OutboundMail {
	to: string;
	subject: string;
	text: string;
}

export interface Mailer {
	send(message: OutboundMail): Promise<void>;
}
