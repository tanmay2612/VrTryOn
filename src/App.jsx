import { useEffect, useState, lazy, Suspense } from "react";
import { getUsers } from "./api";
import { GlobalStyle } from "./globalStyles";
import { BrowserRouter as Router, Route, Routes } from "react-router-dom";

import VirtualTryOnComponent from "./components/getdemo/demo";
import About from "./Sections/About";
import Library from "./Sections/Library";
import Contact from "./Sections/Contact";
import AddOutfit from "./components/AddOutfit";

const Home = lazy(() => import("./Pages/Home"));
const Header = lazy(() => import("./components/Header/index"));
const Footer = lazy(() => import("./components/Footer/index"));
const ScrollToTop = lazy(() => import("./components/ScrollToTop/index"));
const Login = lazy(() => import("./components/LoginPage/login"));

function App() {
  const [data, setData] = useState([]);

  useEffect(() => {
    getUsers()
      .then(setData)
      .catch((err) => console.error(err));
  }, []);

  return (
    <Router>
      <Suspense fallback={<div style={{ textAlign: "center" }}>Loading...</div>}>
        <GlobalStyle />
        <ScrollToTop />
        <Header />

        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/getdemo" element={<VirtualTryOnComponent />} />
          <Route path="/about" element={<About />} />
          <Route path="/add" element={<AddOutfit />} />
          <Route path="/library" element={<Library data={data} />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/" element={<Home data={data} />} />
        </Routes>

        <Footer />
      </Suspense>
    </Router>
  );
}

export default App;