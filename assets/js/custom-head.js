(function () {
    const html = document.documentElement;
    const backgroundImage = "url(/images/background.png)";

    function setBackground() {
        html.style.setProperty("background-image", backgroundImage, "important");
        html.style.setProperty("background-size", "cover", "important");
        html.style.setProperty("background-position", "center", "important");
        html.style.setProperty("background-repeat", "no-repeat", "important");
        html.style.setProperty("background-attachment", "fixed", "important");

        if (document.body) {
            document.body.style.setProperty("background", "transparent", "important");
        }
    }

    setBackground();

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", setBackground, { once: true });
    }

    let rafId = 0;
    const observer = new MutationObserver(function () {
        if (rafId !== 0) {
            return;
        }

        rafId = requestAnimationFrame(function () {
            rafId = 0;
            setBackground();
        });
    });

    observer.observe(html, { attributes: true, attributeFilter: ["data-scheme"] });
})();
