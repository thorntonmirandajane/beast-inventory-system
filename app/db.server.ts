import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient;

declare global {
  var __db__: PrismaClient | undefined;
}

const prismaClientOptions = {
  datasourceUrl: process.env.DATABASE_URL,
};

// This is needed because in development we don't want to restart
// the server with every change, but we want to make sure we don't
// create a new connection to the DB with every change either.
if (process.env.NODE_ENV === "production") {
  prisma = new PrismaClient(prismaClientOptions);
} else {
  if (!global.__db__) {
    global.__db__ = new PrismaClient(prismaClientOptions);
  }
  prisma = global.__db__;
  prisma.$connect();
}

export default prisma;
