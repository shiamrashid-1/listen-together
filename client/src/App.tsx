import { BrowserRouter, Route, Routes } from "react-router-dom";
import { RoomProvider } from "./context/RoomContext";
import Home from "./pages/Home";
import Room from "./pages/Room";

export default function App() {
  return (
    <BrowserRouter>
      <RoomProvider>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/room/:code" element={<Room />} />
        </Routes>
      </RoomProvider>
    </BrowserRouter>
  );
}
