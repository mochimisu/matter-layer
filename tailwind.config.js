export default {
  content: ["./web/index.html", "./web/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        gaia: {
          bg: "#e9e9e5",
          paper: "#f4f3ef",
          tile: "#f8f7f2",
          ink: "#25292c",
          muted: "#71787d",
          line: "#cfd2cf",
          cyan: "#21a4c6",
          yellow: "#ffd91f",
          orange: "#f08a24",
          purple: "#8d5be8",
          green: "#9bc245",
          red: "#c94f3d",
        },
      },
      borderRadius: {
        gaia: "2px",
      },
      boxShadow: {
        gaia: "0 0.35rem 0.8rem rgba(45,49,51,0.10)",
      },
    },
  },
  plugins: [],
};
