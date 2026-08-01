import { connection } from "next/server";
import ChatHelpApp from "@/components/ChatHelpApp";

export default async function Home() {
  if (process.env.CHATHELP_NATIVE_BUILD !== "1") await connection();
  return <ChatHelpApp />;
}
