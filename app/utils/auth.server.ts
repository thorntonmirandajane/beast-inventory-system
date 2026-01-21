import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { redirect } from "react-router";
import prisma from "../db.server";
import type { User, UserRole } from "@prisma/client";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";
const COOKIE_NAME = "beast_auth_token";

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
}

// ============================================
// PASSWORD UTILITIES
// ============================================

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(
  password: string,
  hashedPassword: string
): Promise<boolean> {
  return bcrypt.compare(password, hashedPassword);
}

// ============================================
// JWT UTILITIES
// ============================================

function createToken(user: User): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: "24h" }
  );
}

function verifyToken(token: string): AuthUser | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
    return decoded;
  } catch {
    return null;
  }
}

// ============================================
// COOKIE UTILITIES
// ============================================

function getTokenFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").reduce((acc, cookie) => {
    const [key, value] = cookie.trim().split("=");
    acc[key] = value;
    return acc;
  }, {} as Record<string, string>);

  return cookies[COOKIE_NAME] || null;
}

export function createAuthCookie(token: string): string {
  const maxAge = 60 * 60 * 24; // 24 hours
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
    process.env.NODE_ENV === "production" ? "; Secure" : ""
  }`;
}

export function createLogoutCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ============================================
// AUTH FUNCTIONS
// ============================================

/**
 * Login a user and return the auth token
 */
export async function login(
  email: string,
  password: string
): Promise<{ success: boolean; token?: string; error?: string }> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (!user) {
    return { success: false, error: "Invalid email or password" };
  }

  if (!user.isActive) {
    return { success: false, error: "Account is disabled" };
  }

  const isValid = await verifyPassword(password, user.password);
  if (!isValid) {
    return { success: false, error: "Invalid email or password" };
  }

  const token = createToken(user);
  return { success: true, token };
}

/**
 * Register a new user
 */
export async function register(
  email: string,
  password: string,
  firstName: string,
  lastName: string,
  role: UserRole = "WORKER"
): Promise<{ success: boolean; user?: User; error?: string }> {
  // Check if email already exists
  const existing = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (existing) {
    return { success: false, error: "Email already registered" };
  }

  const hashedPassword = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      password: hashedPassword,
      firstName,
      lastName,
      role,
    },
  });

  return { success: true, user };
}

/**
 * Get the current user from request (if logged in)
 */
export async function getUser(request: Request): Promise<AuthUser | null> {
  const token = getTokenFromRequest(request);
  if (!token) return null;

  const decoded = verifyToken(token);
  if (!decoded) return null;

  // Verify user still exists and is active
  const user = await prisma.user.findUnique({
    where: { id: decoded.id },
  });

  if (!user || !user.isActive) return null;

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
  };
}

/**
 * Require user to be logged in - redirects to login if not
 */
export async function requireUser(request: Request): Promise<AuthUser> {
  const user = await getUser(request);
  if (!user) {
    throw redirect("/login");
  }
  return user;
}

/**
 * Require user to have specific role(s)
 */
export async function requireRole(
  request: Request,
  roles: UserRole[]
): Promise<AuthUser> {
  const user = await requireUser(request);
  if (!roles.includes(user.role)) {
    throw new Response("Unauthorized", { status: 403 });
  }
  return user;
}

/**
 * Create audit log entry
 */
export async function createAuditLog(
  userId: string | null,
  action: string,
  resourceType: string,
  resourceId: string,
  details?: Record<string, unknown>
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId,
      action,
      resourceType,
      resourceId,
      details: details || undefined,
    },
  });
}
