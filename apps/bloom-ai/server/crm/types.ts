// Shared CRM shapes. Both the GoHighLevel adapter and the local demo adapter
// normalise into these so the rest of the app never sees vendor payloads.

export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  phone: string;
  companyName: string;
  website: string;
  city: string;
  state: string;
  source: string;
  tags: string[];
  dateAdded: string; // ISO
  lastActivity: string | null; // ISO
  dnd: boolean;
  assignedTo: string; // user id ("" = unassigned)
  customFields: CustomFieldValue[];
}

export interface CustomFieldValue {
  id: string;
  value: string;
}

export interface CustomField {
  id: string;
  name: string;
  dataType: string; // TEXT, LARGE_TEXT, NUMERICAL, MONETORY, DATE, SINGLE_OPTIONS, ...
  options: string[];
}

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface ContactInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  website?: string;
  city?: string;
  state?: string;
  source?: string;
  tags?: string[];
  assignedTo?: string;
  customFields?: CustomFieldValue[];
}

export interface Stage {
  id: string;
  name: string;
  position: number;
}

export interface Pipeline {
  id: string;
  name: string;
  stages: Stage[];
}

export type OpportunityStatus = "open" | "won" | "lost" | "abandoned";

export interface Opportunity {
  id: string;
  name: string;
  pipelineId: string;
  stageId: string;
  status: OpportunityStatus;
  value: number;
  contactId: string;
  contactName: string;
  companyName: string;
  createdAt: string;
  updatedAt: string;
  lastStageChangeAt: string | null;
}

export interface OpportunityInput {
  name?: string;
  pipelineId?: string;
  stageId?: string;
  status?: OpportunityStatus;
  value?: number;
  contactId?: string;
}

export interface Note {
  id: string;
  contactId: string;
  body: string;
  dateAdded: string;
}

export interface Task {
  id: string;
  contactId: string;
  title: string;
  body: string;
  dueDate: string;
  completed: boolean;
  assignedTo: string;
  contactName: string;
}

export interface TaskInput {
  title: string;
  body?: string;
  dueDate: string;
  assignedTo?: string;
  completed?: boolean;
}

export interface Appointment {
  id: string;
  title: string;
  contactId: string | null;
  calendarName: string;
  startTime: string;
  endTime: string;
  status: string;
}

export interface Message {
  id: string;
  contactId: string;
  direction: "inbound" | "outbound";
  channel: string; // SMS, Email, FB, IG, WhatsApp, Call, Live chat, ...
  body: string;
  dateAdded: string;
}

export interface SendMessageInput {
  contactId: string;
  channel: SendChannel;
  body: string;
  subject?: string;
}

/** Channels Bloom AI can send on. FB = Messenger, IG = Instagram DM (both via GoHighLevel's connected Facebook page / Instagram account). */
export type SendChannel = "SMS" | "Email" | "FB" | "IG" | "WhatsApp";
export const SEND_CHANNELS: SendChannel[] = ["SMS", "Email", "FB", "IG", "WhatsApp"];

/** GHL message types (TYPE_SMS, TYPE_INSTAGRAM, …) and loose spellings → one channel code. */
export function normalizeChannel(raw: string): string {
  const t = raw.toUpperCase().replace(/^TYPE_/, "").replace(/[^A-Z]/g, "");
  if (t === "SMS" || t === "PHONE" || t === "TEXT") return "SMS";
  if (t === "EMAIL") return "Email";
  if (t === "FB" || t === "FACEBOOK" || t === "MESSENGER") return "FB";
  if (t === "IG" || t === "INSTAGRAM") return "IG";
  if (t === "WHATSAPP") return "WhatsApp";
  if (t === "CALL") return "Call";
  if (t === "LIVECHAT") return "Live chat";
  if (t === "GMB") return "Google";
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : "Message";
}

export interface Conversation {
  id: string;
  contactId: string;
  contactName: string;
  lastMessageBody: string;
  lastMessageDate: string; // ISO
  lastMessageDirection: "inbound" | "outbound";
  channel: string;
  unread: number;
}

export interface ContactQuery {
  query?: string;
  limit?: number;
}

export interface CrmInfo {
  mode: "ghl" | "demo";
  accountName: string;
}

export interface Crm {
  info(): Promise<CrmInfo>;
  listContacts(q: ContactQuery): Promise<Contact[]>;
  getContact(id: string): Promise<Contact | null>;
  createContact(input: ContactInput): Promise<Contact>;
  updateContact(id: string, input: ContactInput): Promise<Contact>;
  deleteContact(id: string): Promise<void>;
  addTags(id: string, tags: string[]): Promise<void>;
  removeTags(id: string, tags: string[]): Promise<void>;

  listUsers(): Promise<User[]>;
  listCustomFields(): Promise<CustomField[]>;

  listPipelines(): Promise<Pipeline[]>;
  listOpportunities(pipelineId?: string): Promise<Opportunity[]>;
  createOpportunity(input: OpportunityInput): Promise<Opportunity>;
  updateOpportunity(id: string, input: OpportunityInput): Promise<Opportunity>;
  deleteOpportunity(id: string): Promise<void>;

  listNotes(contactId: string): Promise<Note[]>;
  addNote(contactId: string, body: string): Promise<Note>;
  updateNote(contactId: string, noteId: string, body: string): Promise<Note>;
  deleteNote(contactId: string, noteId: string): Promise<void>;

  listTasks(contactId: string): Promise<Task[]>;
  addTask(contactId: string, input: TaskInput): Promise<Task>;
  completeTask(contactId: string, taskId: string, completed: boolean): Promise<void>;
  updateTask(contactId: string, taskId: string, input: Partial<TaskInput>): Promise<Task>;
  deleteTask(contactId: string, taskId: string): Promise<void>;
  /** Every task in the account (open first). */
  listAllTasks(opts: { completed?: boolean; limit?: number }): Promise<Task[]>;

  listAppointments(fromIso: string, toIso: string): Promise<Appointment[]>;

  listMessages(contactId: string): Promise<Message[]>;
  /** Most recently active conversations first. */
  listConversations(limit: number): Promise<Conversation[]>;
  sendMessage(input: SendMessageInput): Promise<{ id: string; delivered: boolean }>;
}

export class CrmError extends Error {
  constructor(
    message: string,
    public status = 500,
    public detail?: unknown,
  ) {
    super(message);
  }
}
