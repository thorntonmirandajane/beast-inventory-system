-- AI Chat transcripts: one row per conversation, one per message.
CREATE TABLE IF NOT EXISTS "ai_conversations" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ai_conversations_userId_updatedAt_idx"
  ON "ai_conversations"("userId","updatedAt");
CREATE INDEX IF NOT EXISTS "ai_conversations_updatedAt_idx"
  ON "ai_conversations"("updatedAt");

CREATE TABLE IF NOT EXISTS "ai_messages" (
  "id" TEXT PRIMARY KEY,
  "conversationId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "tools" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ai_messages_conversationId_createdAt_idx"
  ON "ai_messages"("conversationId","createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_conversations_userId_fkey') THEN
    ALTER TABLE "ai_conversations"
      ADD CONSTRAINT "ai_conversations_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_messages_conversationId_fkey') THEN
    ALTER TABLE "ai_messages"
      ADD CONSTRAINT "ai_messages_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
