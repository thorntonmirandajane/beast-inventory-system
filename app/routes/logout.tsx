import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { createLogoutCookie } from "../utils/auth.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  return redirect("/login", {
    headers: {
      "Set-Cookie": createLogoutCookie(),
    },
  });
};

export const loader = async () => {
  return redirect("/login", {
    headers: {
      "Set-Cookie": createLogoutCookie(),
    },
  });
};
