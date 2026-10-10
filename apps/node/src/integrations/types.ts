export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO 8601
  end: string;
  attendees: string[];
  location?: string;
  description?: string;
  organizer?: string;
  /** The owner's response to an invitation, when known. */
  responseStatus?: "needsAction" | "accepted" | "declined" | "tentative";
  htmlLink?: string;
}

export interface NewEvent {
  title: string;
  start: string;
  end: string;
  attendees?: string[];
  location?: string;
  description?: string;
}

export interface CalendarProvider {
  readonly name: string;
  listEvents(from: Date, to: Date): Promise<CalendarEvent[]>;
  createEvent(event: NewEvent): Promise<CalendarEvent>;
  updateEvent(id: string, patch: Partial<NewEvent>): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;
  respond(id: string, response: "accepted" | "declined" | "tentative"): Promise<CalendarEvent>;
}

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
}

export interface Email extends EmailSummary {
  body: string;
  messageIdHeader?: string;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  replyToId?: string;
}

export interface MailProvider {
  readonly name: string;
  search(query: string, max: number): Promise<EmailSummary[]>;
  get(id: string): Promise<Email>;
  /** Unread inbox messages received after the given time. */
  newInbox(sinceMs: number): Promise<EmailSummary[]>;
  createDraft(mail: OutgoingEmail): Promise<{ id: string }>;
  send(mail: OutgoingEmail): Promise<{ id: string }>;
  ownerAddress(): Promise<string | undefined>;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  owners?: { emailAddress?: string; displayName?: string }[];
}

export interface DriveProvider {
  search(query: string, max: number): Promise<DriveFile[]>;
  read(id: string): Promise<{ file: DriveFile; text: string }>;
}
