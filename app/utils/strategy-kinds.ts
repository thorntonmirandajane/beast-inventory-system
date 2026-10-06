// Strategy names and descriptions. Deliberately free of server imports: the
// comparison page renders these in the browser, and importing them from a
// .server module would drag the whole server bundle into the client build.

export type StrategyKind =
  | "FULL_FIRST_THEN_PARTIAL"
  | "OLDEST_FIRST"
  | "FULL_ONLY"
  | "MOST_ORDERS_CLEARED"
  | "HIGHEST_VALUE_FIRST"
  | "CUSTOMERS_FIRST";

export const STRATEGIES: { kind: StrategyKind; label: string; blurb: string }[] = [
  {
    kind: "FULL_FIRST_THEN_PARTIAL",
    label: "Whole orders first, then part-fill",
    blurb: "Oldest to newest, ship every order that can go out complete; then go back and part-fill the rest until the stock runs out.",
  },
  {
    kind: "OLDEST_FIRST",
    label: "Straight oldest first",
    blurb: "Work the backlog strictly by age, shipping whatever each order can take, whole or partial.",
  },
  {
    kind: "FULL_ONLY",
    label: "Whole orders only",
    blurb: "Only ship orders that can go out complete. Nothing is part-filled, so no customer gets a split shipment.",
  },
  {
    kind: "MOST_ORDERS_CLEARED",
    label: "Clear the most orders",
    blurb: "Ship the smallest complete orders first, to close the greatest number of orders from the stock on hand.",
  },
  {
    kind: "HIGHEST_VALUE_FIRST",
    label: "Highest value first",
    blurb: "Biggest-ticket orders first, whole or partial — releases the most revenue soonest.",
  },
  {
    kind: "CUSTOMERS_FIRST",
    label: "Named customers first",
    blurb: "Your chosen customers get the stock first, oldest among them first; everyone else takes what's left by age.",
  },
];
