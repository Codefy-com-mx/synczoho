import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import NexoSyncRoute from "@/components/NexoSyncRoute";
import Index from "./pages/Index";
import AuthCallback from "./pages/AuthCallback";
import ZohoCallback from "./pages/ZohoCallback";
import NotFound from "./pages/NotFound";

const App = () => (
  <TooltipProvider>
    <Toaster />
    <BrowserRouter>
      <NexoSyncRoute>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/zoho/callback" element={<ZohoCallback />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </NexoSyncRoute>
    </BrowserRouter>
  </TooltipProvider>
);

export default App;
