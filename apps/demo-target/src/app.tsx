import { useEffect, useState } from "react";

interface Product {
  slug: string;
  name: string;
  category: string;
  price: string;
  summary: string;
  badge: string;
  highlight: string;
  specs: string[];
  shipping: string;
  support: string;
}

const PRODUCTS: Product[] = [
  {
    slug: "wireless-headphones",
    name: "AeroPulse X9 Headphones",
    category: "Audio",
    price: "$199",
    summary: "Adaptive noise cancellation with low-latency wireless audio and all-day comfort.",
    badge: "Best Seller",
    highlight: "40-hour battery with spatial audio tuning",
    specs: ["40hr battery", "Bluetooth 5.4", "USB-C fast charge"],
    shipping: "Free 2-day shipping",
    support: "2-year audio warranty included",
  },
  {
    slug: "travel-backpack",
    name: "Vector One Travel Pack",
    category: "Carry",
    price: "$129",
    summary: "Structured commuter pack with weatherproof shell and modular tech storage.",
    badge: "New",
    highlight: "Fits 16-inch laptops with cable organization",
    specs: ["24L capacity", "Weatherproof shell", "RFID passport pocket"],
    shipping: "Ships tomorrow",
    support: "30-day no-hassle returns",
  },
  {
    slug: "smart-desk-lamp",
    name: "Luma Forge Desk Lamp",
    category: "Workspace",
    price: "$89",
    summary: "Precision task lighting with warm-to-cool presets and clean cable-free charging.",
    badge: "Editor Pick",
    highlight: "Touch controls with USB-C accessory charging",
    specs: ["Touch dimmer", "Qi pad base", "CRI 95 light output"],
    shipping: "In stock for same-week delivery",
    support: "Live support seven days a week",
  },
];

const FEATURES = [
  { label: "Fast dispatch", value: "Orders out in under 24 hours" },
  { label: "Verified support", value: "Human support for setup and returns" },
  { label: "Protected checkout", value: "Encrypted checkout with order tracking" },
];

const CATEGORY_SPOTLIGHTS = [
  { title: "Portable audio", description: "Commuter-ready listening gear built for travel, calls, and focused work." },
  { title: "Carry systems", description: "Everyday bags designed for creators, founders, and remote teams." },
  { title: "Workspace upgrades", description: "Desk hardware that improves signal, lighting, and flow." },
];

const ROUTES = {
  home: "/",
  login: "/login",
  products: "/products",
  cart: "/cart",
} as const;

function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function usePathname() {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const updatePathname = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", updatePathname);
    return () => window.removeEventListener("popstate", updatePathname);
  }, []);

  return pathname;
}

export function App() {
  const pathname = usePathname();
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [cartCount, setCartCount] = useState(1);

  const selectedProduct = PRODUCTS.find((product) => pathname === `/products/${product.slug}`);

  return (
    <div className="page-shell">
      <div className="background-grid" />
      <div className="glow glow-left" />
      <div className="glow glow-right" />

      <header className="site-header">
        <button className="brand" onClick={() => navigate(ROUTES.home)} type="button">
          <span className="brand-mark">A</span>
          <span className="brand-copy">
            <strong>Northstar Electronics</strong>
            <small>Performance gear for modern teams</small>
          </span>
        </button>

        <nav className="site-nav" aria-label="Primary">
          <button onClick={() => navigate(ROUTES.products)} type="button">
            Products
          </button>
          <button onClick={() => navigate(ROUTES.login)} type="button">
            {isSignedIn ? "Account" : "Login"}
          </button>
          <button onClick={() => navigate(ROUTES.cart)} type="button">
            Cart ({cartCount})
          </button>
        </nav>
      </header>

      <main className="content">
        {pathname === ROUTES.home ? <HomePage /> : null}
        {pathname === ROUTES.login ? <LoginPage isSignedIn={isSignedIn} onSignIn={() => setIsSignedIn(true)} /> : null}
        {pathname === ROUTES.products ? <ProductsPage /> : null}
        {selectedProduct != null ? (
          <ProductDetailPage
            cartCount={cartCount}
            product={selectedProduct}
            onAddToCart={() => setCartCount((count) => count + 1)}
          />
        ) : null}
        {pathname === ROUTES.cart ? <CartPage cartCount={cartCount} /> : null}
        {!Object.values(ROUTES).includes(pathname as (typeof ROUTES)[keyof typeof ROUTES]) &&
        selectedProduct == null ? (
          <NotFoundPage />
        ) : null}
      </main>
    </div>
  );
}

function HomePage() {
  const featuredProduct = PRODUCTS[0];

  if (featuredProduct == null) {
    return null;
  }

  return (
    <div className="page-stack">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">Spring drop 2026</span>
          <h1>Tools, audio, and work gear built like flagship hardware.</h1>
          <p>
            Shop a tighter lineup of high-performance gadgets with cleaner design, faster delivery, and specs you can
            actually compare.
          </p>
          <div className="hero-actions">
            <button className="primary-button" onClick={() => navigate(ROUTES.products)} type="button">
              Shop all products
            </button>
            <button
              className="secondary-button"
              onClick={() => navigate(`/products/${featuredProduct.slug}`)}
              type="button"
            >
              View featured product
            </button>
          </div>
          <div className="feature-strip">
            {FEATURES.map((feature) => (
              <div className="feature-pill" key={feature.label}>
                <span>{feature.label}</span>
                <strong>{feature.value}</strong>
              </div>
            ))}
          </div>
        </div>

        <aside className="hero-panel">
          <span className="panel-label">Featured system</span>
          <h2>{featuredProduct.name}</h2>
          <p>{featuredProduct.summary}</p>
          <div className="price-row">
            <strong>{featuredProduct.price}</strong>
            <span>{featuredProduct.shipping}</span>
          </div>
          <ul className="spec-list">
            {featuredProduct.specs.map((spec) => (
              <li key={spec}>{spec}</li>
            ))}
          </ul>
          <div className="panel-foot">
            <span>{featuredProduct.support}</span>
            <button
              className="ghost-button"
              onClick={() => navigate(`/products/${featuredProduct.slug}`)}
              type="button"
            >
              Explore
            </button>
          </div>
        </aside>
      </section>

      <section className="panel-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Shop by category</span>
            <h2>Curated hardware for travel, focus, and desk setups.</h2>
          </div>
        </div>
        <div className="category-grid">
          {CATEGORY_SPOTLIGHTS.map((category) => (
            <article className="category-card" key={category.title}>
              <span className="category-badge">{category.title}</span>
              <p>{category.description}</p>
              <button className="ghost-button" onClick={() => navigate(ROUTES.products)} type="button">
                Browse category
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="panel-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Featured inventory</span>
            <h2>Best-performing products this week.</h2>
          </div>
        </div>
        <div className="product-grid">
          {PRODUCTS.map((product) => (
            <ProductCard key={product.slug} product={product} />
          ))}
        </div>
      </section>
    </div>
  );
}

function LoginPage(props: { isSignedIn: boolean; onSignIn: () => void }) {
  return (
    <section className="auth-layout">
      <div className="panel-section auth-copy">
        <span className="eyebrow">Member access</span>
        <h2>Sign in for order history, saved carts, and faster checkout.</h2>
        <p>
          Use the prefilled credentials to move through the account flow quickly while keeping the experience aligned
          with a real retail sign-in page.
        </p>
        <div className="inline-metrics">
          <div className="metric-card">
            <strong>2-day</strong>
            <span>average delivery</span>
          </div>
          <div className="metric-card">
            <strong>24/7</strong>
            <span>order tracking</span>
          </div>
        </div>
      </div>

      <section className="panel-section auth-panel narrow-panel">
        <span className="eyebrow">Login</span>
        <h2>Access your account</h2>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSignIn();
          }}
        >
          <label className="field">
            <span>Email address</span>
            <input defaultValue="demo@autonoma.app" name="email" type="email" />
          </label>
          <label className="field">
            <span>Password</span>
            <input defaultValue="password123" name="password" type="password" />
          </label>
          <button className="primary-button" type="submit">
            Sign In
          </button>
        </form>
        <div className="status-banner">
          <strong>Status:</strong> {props.isSignedIn ? "Signed in successfully" : "Ready for sign-in"}
        </div>
      </section>
    </section>
  );
}

function ProductsPage() {
  return (
    <section className="page-stack">
      <section className="catalog-shell">
        <div className="catalog-header">
          <div>
            <span className="eyebrow">Catalog</span>
            <h2>Performance gadgets with clear specs and fast shipping.</h2>
          </div>
          <label className="search-chip">
            <span>Search products</span>
            <input aria-label="Search products" defaultValue="wireless headphones" />
          </label>
        </div>

        <div className="filter-row">
          <span className="filter-pill active">All products</span>
          <span className="filter-pill">Audio</span>
          <span className="filter-pill">Carry</span>
          <span className="filter-pill">Workspace</span>
        </div>

        <div className="product-grid">
          {PRODUCTS.map((product) => (
            <ProductCard key={product.slug} product={product} />
          ))}
        </div>
      </section>
    </section>
  );
}

function ProductDetailPage(props: { cartCount: number; product: Product; onAddToCart: () => void }) {
  return (
    <section className="detail-layout">
      <div className="detail-visual">
        <span className="visual-badge">{props.product.badge}</span>
        <div className="visual-core" />
        <div className="visual-meta">
          <span>{props.product.highlight}</span>
        </div>
      </div>

      <div className="detail-copy panel-section">
        <span className="eyebrow">{props.product.category}</span>
        <h2>{props.product.name}</h2>
        <p>{props.product.summary}</p>
        <div className="price-row">
          <strong>{props.product.price}</strong>
          <span>{props.product.shipping}</span>
        </div>
        <ul className="spec-list">
          {props.product.specs.map((spec) => (
            <li key={spec}>{spec}</li>
          ))}
        </ul>
        <div className="support-card">
          <span>{props.product.support}</span>
        </div>
        <div className="hero-actions">
          <button className="primary-button" onClick={props.onAddToCart} type="button">
            Add to Cart
          </button>
          <button className="secondary-button" onClick={() => navigate(ROUTES.cart)} type="button">
            View cart
          </button>
        </div>
        <div className="status-banner">
          <strong>Cart items:</strong> {props.cartCount}
        </div>
      </div>
    </section>
  );
}

function CartPage(props: { cartCount: number }) {
  return (
    <section className="page-stack">
      <section className="cart-shell">
        <div className="panel-section cart-main">
          <span className="eyebrow">Cart</span>
          <h2>Review your order</h2>
          <div className="cart-item">
            <div>
              <strong>AeroPulse X9 Headphones</strong>
              <p>Spatial audio, adaptive ANC, USB-C fast charge</p>
            </div>
            <span>$199</span>
          </div>
          <div className="cart-item">
            <div>
              <strong>Items in cart</strong>
              <p>Stable quantity state for the public demo flow</p>
            </div>
            <span>{props.cartCount}</span>
          </div>
          <button className="secondary-button" onClick={() => navigate(ROUTES.products)} type="button">
            Continue shopping
          </button>
        </div>

        <aside className="panel-section cart-summary">
          <span className="eyebrow">Summary</span>
          <h2>Order overview</h2>
          <div className="summary-row">
            <span>Subtotal</span>
            <strong>$199</strong>
          </div>
          <div className="summary-row">
            <span>Shipping</span>
            <strong>Free</strong>
          </div>
          <div className="summary-row total-row">
            <span>Total</span>
            <strong>$199</strong>
          </div>
          <button className="primary-button" type="button">
            Secure checkout
          </button>
        </aside>
      </section>
    </section>
  );
}

function NotFoundPage() {
  return (
    <section className="panel-section narrow-panel">
      <span className="eyebrow">Not found</span>
      <h2>This page is outside the current storefront flow.</h2>
      <button className="primary-button" onClick={() => navigate(ROUTES.home)} type="button">
        Return home
      </button>
    </section>
  );
}

function ProductCard(props: { product: Product }) {
  return (
    <article className="product-card">
      <div className="card-topline">
        <span className="product-badge">{props.product.badge}</span>
        <span className="stock-pill">{props.product.shipping}</span>
      </div>
      <div className="product-visual" aria-hidden="true" />
      <div className="product-copy">
        <span className="product-category">{props.product.category}</span>
        <h3>{props.product.name}</h3>
        <p>{props.product.summary}</p>
      </div>
      <ul className="spec-list compact-specs">
        {props.product.specs.map((spec) => (
          <li key={spec}>{spec}</li>
        ))}
      </ul>
      <div className="product-meta">
        <strong>{props.product.price}</strong>
        <span>{props.product.highlight}</span>
      </div>
      <button className="secondary-button" onClick={() => navigate(`/products/${props.product.slug}`)} type="button">
        View product
      </button>
    </article>
  );
}
