"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { useLeaveGuard } from "@/lib/unsaved-changes";

/** 画面を移る Link。保存していない変更があるときは、移る前に確かめる。 */
export function GuardedLink(props: ComponentProps<typeof Link>) {
  const guard = useLeaveGuard();
  return <Link {...props} onNavigate={guard} />;
}
