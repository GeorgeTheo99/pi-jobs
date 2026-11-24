import { createBrowserRouter } from "react-router-dom";
import { AuthGate } from "./components/AuthGate";
import { Layout } from "./components/Layout";
import { ChatPage, ChatsPage } from "./pages/ChatPage";
import { InboxPage } from "./pages/InboxPage";
import { JobPage } from "./pages/JobPage";
import { JobsPage } from "./pages/JobsPage";
import { NotFound } from "./pages/NotFound";
import { ItemPage } from "./pages/item/ItemPage";
import { RunsPage } from "./pages/RunsPage";
import { SettingsPage } from "./pages/SettingsPage";

// The server sets <base href> to the proxy prefix ("/pi-jobs/" behind Caddy, "/" directly).
const basename = new URL(document.baseURI).pathname.replace(/\/$/, "");

export const router = createBrowserRouter([
  {
    element: (
      <AuthGate>
        <Layout />
      </AuthGate>
    ),
    children: [
      { path: "/", element: <InboxPage /> },
      { path: "/chats", element: <ChatsPage /> },
      { path: "/chats/:id", element: <ChatPage /> },
      { path: "/jobs", element: <JobsPage /> },
      { path: "/jobs/new", element: <JobPage /> },
      { path: "/jobs/:id", element: <JobPage /> },
      { path: "/runs", element: <RunsPage /> },
      { path: "/runs/:id", element: <ItemPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
], { basename });
