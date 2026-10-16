import { redirect } from "next/navigation";
import { DASHBOARD_PATH } from "@/lib/paths";

/** sacty を開いたら、ダッシュボードを出す（PBI-114）。 */
export default function Home() {
  redirect(DASHBOARD_PATH);
}
