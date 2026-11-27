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
}

export interface TaskInput {
  title: string;
  body?: string;
  dueDate: string;
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
  channel: string; // SMS, Email, Call, ...
  body: string;
  dateAdded: string;
}

export interface SendMessageInput {
  contactId: string;
  channel: "SMS" | "Email";
  body: string;
  subject?: string;
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
  addTags(id: string, tags: string[]): Promise<void>;

  listPipelines(): Promise<Pipeline[]>;
  listOpportunities(pipelineId?: string): Promise<Opportunity[]>;
  createOpportunity(input: OpportunityInput): Promise<Opportunity>;
  updateOpportunity(id: string, input: OpportunityInput): Promise<Opportunity>;

  listNotes(contactId: string): Promise<Note[]>;
  addNote(contactId: string, body: string): Promise<Note>;

  listTasks(contactId: string): Promise<Task[]>;
  addTask(contactId: string, input: TaskInput): Promise<Task>;
  completeTask(contactId: string, taskId: string, completed: boolean): Promise<void>;

  listAppointments(fromIso: string, toIso: string): Promise<Appointment[]>;

  listMessages(contactId: string): Promise<Message[]>;
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
