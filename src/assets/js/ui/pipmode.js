var med = null;
var self = null;

export default class PipMode {
    constructor(mediator) {
        med = mediator;
        self = this;
        window.ee.on("pip-toggled", function () {
            self.toggle()
        });
        return this;
    }

    async toggle() {
        const elem = document.getElementById("pip");
        elem.play();

        if ( "fullscreenEnabled" in document) {
            if (!document.fullscreen) {
                await elem.requestFullscreen().catch(error => {
                    elem.requestFullscreen();
                });
                elem.srcObject = document.getElementsByClassName("remote-video")[0].srcObject
                elem.play();
            } else {
                if (document.pictureInPictureElement) {
                    document.exitPictureInPicture();
                } else {
                    document.exitFullscreen();
                }
            }
        }
    }
}