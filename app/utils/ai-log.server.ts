// ============================================================================
// AI Chat transcript store.
//
// Conversations are kept server-side so they survive a browser change and so
// an answer can be re-read later with the lookups that produced it. Everyone
// sees their own history; admins can see everyone's.
// ============================================================================

import prisma from "../db.server";
import type { UserRole } from "@prisma/client";

export type StoredTool = { name: string; summary: string; ms?: number; ok?: boolean };

/** First line of the question, trimmed to something that fits a sidebar row. */
export function titleFromQuestion(question: string): string {
  const line = question.trim().split("\n")[0].trim();
  if (line.length <= 70) return line || "Untitled";
  return line.slice(0, 69).trimEnd() + "…";
}

export async function listConversations(opts: {
  userId: string;
  role: UserRole;
  all?: boolean;
  limit?: number;
}) {
  const everyone = opts.all && opts.role === "ADMIN";
  const rows = await prisma.aiConversation.findMany({
    where: everyone ? {} : { userId: opts.userId },
    orderBy: { updatedAt: "desc" },
    take: Math.min(opts.limit ?? 100, 200),
    select: {
      id: true,
      title: true,
      updatedAt: true,
      userId: true,
      user: { select: { firstName: true, lastName: true } },
      _count: { select: { messages: true } },
    },
  });
  return rows.map((c) => ({
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt.toISOString(),
    mine: c.userId === opts.userId,
    author: `${c.user.firstName} ${c.user.lastName}`,
    messageCount: c._count.messages,
  }));
}

/** One conversation with its messages — null if it doesn't exist or isn't yours. */
export async function getConversation(
  id: string,
  opts: { userId: string; role: UserRole }
) {
  const convo = await prisma.aiConversation.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      userId: true,
      updatedAt: true,
      user: { select: { firstName: true, lastName: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        select: { id: true, role: true, content: true, tools: true, error: true, createdAt: true },
      },
    },
  });
  if (!convo) return null;
  if (convo.userId !== opts.userId && opts.role !== "ADMIN") return null;

  return {
    id: convo.id,
    title: convo.title,
    mine: convo.userId === opts.userId,
    author: `${convo.user.firstName} ${convo.user.lastName}`,
    messages: convo.messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
      tools: (m.tools as StoredTool[] | null) ?? undefined,
      error: m.error ?? undefined,
      at: m.createdAt.toISOString(),
    })),
  };
}

export async function createConversation(userId: string, question: string) {
  return prisma.aiConversation.create({
    data: { userId, title: titleFromQuestion(question) },
    select: { id: true, title: true },
  });
}

export async function appendMessage(
  conversationId: string,
  message: { role: "user" | "assistant"; content: string; tools?: StoredTool[]; error?: string }
) {
  await prisma.aiMessage.create({
    data: {
      conversationId,
      role: message.role,
      content: message.content,
      tools: message.tools && message.tools.length > 0 ? message.tools : undefined,
      error: message.error,
    },
  });
  // Touch the conversation so the sidebar orders by real activity.
  await prisma.aiConversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });
}

/**
 * The last few turns of a conversation, as plain text, to give the model
 * context on a follow-up. Tool traffic is not replayed — if a number matters
 * again the assistant looks it up again.
 */
export async function recentTurns(conversationId: string, take = 20) {
  const rows = await prisma.aiMessage.findMany({
    where: { conversationId, content: { not: "" } },
    orderBy: { createdAt: "desc" },
    take,
    select: { role: true, content: true },
  });
  return rows
    .reverse()
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

export async function deleteConversation(
  id: string,
  opts: { userId: string; role: UserRole }
): Promise<boolean> {
  const convo = await prisma.aiConversation.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!convo) return false;
  if (convo.userId !== opts.userId && opts.role !== "ADMIN") return false;
  await prisma.aiConversation.delete({ where: { id } });
  return true;
}
