-- Add IN_ROUTE status to the PO workflow (Submitted -> In Route -> Received).
ALTER TYPE "POStatus" ADD VALUE IF NOT EXISTS 'IN_ROUTE' AFTER 'SUBMITTED';
