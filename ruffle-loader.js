window.WGFWPRuffle = {
    async load(options) {
        const {
            swf,
            width = "100%",
            height = "100%",
            container = "#game",
            parameters = {}
        } = options;

        const target =
            typeof container === "string"
                ? document.querySelector(container)
                : container;

        if (!target)
            throw new Error("Ruffle container not found");

        if (!window.RufflePlayer)
            throw new Error("Ruffle has not loaded");

        const ruffle =
            window.RufflePlayer.newest();

        const player =
            ruffle.createPlayer();

        player.style.width =
            typeof width === "number" ? `${width}px` : width;

        player.style.height =
            typeof height === "number" ? `${height}px` : height;

        target.replaceChildren(player);

        await player.load({
            url: swf,
            parameters,
            autoplay: "on",
            unmuteOverlay: "hidden",
            warnOnUnsupportedContent: false
        });

        return player;
    } // thanks chatgpt
};
