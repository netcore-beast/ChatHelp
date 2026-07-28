import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ChatHelp Private Conversation Studio",
    short_name: "ChatHelp",
    description: "On-device, encrypted assistance for thoughtful professional conversations.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f6f4ed",
    theme_color: "#145c3e",
    icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }],
  };
}
