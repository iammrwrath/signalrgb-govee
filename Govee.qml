import QtQuick.Layouts

Item {
    anchors.fill: parent

    Column{
        width: parent.width
        height: parent.height
        spacing: 10
    
        Pane {
            width: parent.width
            height: (contentHeight + padding * 2) + 30

            background: Rectangle {
                color: "#070d16"
                radius: 8
                border.color: "#18232e"
                border.width: 1.5
            }

            GridLayout {
                id: grid
                anchors.fill: parent
                columns: 3
                rowSpacing: 0
                columnSpacing: 2

                Text{
                    Layout.row: 0
                    Layout.column: 0
                    Layout.columnSpan: 3
                    Layout.fillWidth: true
                    Layout.preferredHeight: 44

                    color: "White"
                    text: "Manually Specify IP Address" 
                    font.family: theme.primaryfont
                    font.weight: Font.Bold
                    font.pixelSize: 24
                }

                TextField {
                    Layout.row: 1
                    Layout.column: 0
                    Layout.fillWidth: false
                    Layout.preferredWidth: 323
                    Layout.preferredHeight: 44

                    id: discoverIP
                    color: theme.secondarytextcolor
                    font.family: theme.secondaryfont

                    validator: RegularExpressionValidator {
                        regularExpression:  /^((?:[0-1]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])\.){0,3}(?:[0-1]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])$/
                    }
                    
                    onEditingFinished: {
                        discovery.checkCachedDevice(discoverIP.text);
                    }

                    background: Rectangle {
                        color: theme.background3
                        radius: 4
                    }
                }

                Item {
                    Layout.row: 2
                    Layout.column: 0
                    Layout.fillWidth: true
                    Layout.preferredHeight: 44

                    SButton{
                        id: cacheButton
                        width: 156
                        height: 44

                        color: hovered ? Qt.darker("#304152", 1.5) : "#304152"

                        label.font.pixelSize: 16
                        label.font.family: "Red Hat Display"
                        label.font.bold: true
                        label.text: "Clear IP Cache"

                        onClicked : {
                            cacheBurnBox.visible = true
                        }
                    }

                    SButton{
                        id: checkButton
                        width: 156
                        height: 44
                        anchors.left: cacheButton.right
                        anchors.leftMargin: 10

                        color: hovered ? Qt.darker("#5664b1", 1.5) : "#5664b1"

                        label.font.pixelSize: 16
                        label.font.family: "Red Hat Display"
                        label.font.bold: true
                        label.text: "Check IP"

                        onClicked : {
                            discovery.checkCachedDevice(discoverIP.text);
                        }
                    }
                }

                RowLayout {
                    Layout.row: 1
                    Layout.column: 1
                    Layout.columnSpan: 2
                    Layout.fillWidth: true
                    Layout.alignment: Qt.AlignVCenter

                    spacing: 10

                    BusyIndicator {
                        id: scanningIndicator
                        Layout.alignment: Qt.AlignVCenter
                        Material.accent: "#88FFFFFF"
                        running: true
                        implicitWidth: 40
                        implicitHeight: 40
                    }

                    Text {
                        id: scanningText
                        Layout.alignment: Qt.AlignVCenter
                        Layout.fillWidth: true
                        verticalAlignment: Text.AlignVCenter
                        color: "#88FFFFFF"
                        text: "Searching network for devices. \nThis may take several minutes..."
                        font.pixelSize: 14
                        font.family: "Red Hat Display"
                    }
                }
            }
        }

        ScrollView {
            width: parent.width
            height: parent.height - y
            clip: true
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff

            Grid {
                id: deviceGrid
                width: parent.parent.width
                columns: Math.max(1, Math.floor(width / 362)) // 352 + 10 for spacing
                spacing: 10

                property int itemWidth: (width - (columns - 1) * spacing) / columns

                Repeater{
                    model: service.controllers

                    delegate: Pane {
                        id: root
                        width: deviceGrid.itemWidth
                        height: (contentHeight + padding * 2) + 30// dynamic height based on content
                        padding: 12

                        background: Rectangle {
                            color: "#070d16"
                            radius: 8
                            border.color: "#18232e"
                            border.width: 3
                        }

                        property var device: model.modelData.obj

                        ColumnLayout{
                            width: parent.width
                            spacing: 4

                            Item{
                                Layout.fillWidth: true
                                height: 80

                                Image {
                                    id: deviceImage
                                    anchors.left: parent.left
                                    anchors.leftMargin: 10
                                    anchors.verticalCenter: parent.verticalCenter
                                    width: 120
                                    height: 120
                                    source: root.device.deviceImage
                                    antialiasing: false
                                    mipmap: false
                                }

                                Item {
                                    id: textContainer
                                    anchors.left: deviceImage.right
                                    anchors.leftMargin: 10
                                    anchors.right: parent.right
                                    anchors.rightMargin: 10
                                    anchors.top: parent.top
                                    height: 80

                                    Text{
                                        y: 0
                                        id: deviceName
                                        anchors.left: parent.left
                                        anchors.right: removeButton.left
                                        anchors.rightMargin: 10
                                        color: theme.primarytextcolor
                                        text: root.device.name
                                        font.pixelSize: 18
                                        font.family: theme.primaryfont
                                        font.weight: Font.Bold
                                        verticalAlignment: Text.AlignVCenter
                                        elide: Text.ElideRight
                                    }

                                    Text{
                                        y: 26
                                        anchors.left: parent.left
                                        anchors.right: removeButton.left
                                        anchors.rightMargin: 10
                                        font.pixelSize: 12
                                        font.family: "Montserrat Regular"
                                        verticalAlignment: Text.AlignVCenter
                                        color: theme.secondarytextcolor
                                        text: `ID: ${root.device.id}`
                                        elide: Text.ElideRight
                                    }

                                    Text{
                                        y: 42
                                        anchors.left: parent.left
                                        anchors.right: removeButton.left
                                        anchors.rightMargin: 10
                                        font.pixelSize: 12
                                        font.family: "Montserrat Regular"
                                        verticalAlignment: Text.AlignVCenter
                                        color: theme.secondarytextcolor
                                        text: `Model: ${root.device.sku}`
                                        elide: Text.ElideRight
                                    }

                                    Text{
                                        y: 58
                                        anchors.left: parent.left
                                        anchors.right: removeButton.left
                                        anchors.rightMargin: 10
                                        font.pixelSize: 12
                                        font.family: "Montserrat Regular"
                                        verticalAlignment: Text.AlignVCenter
                                        color: theme.secondarytextcolor
                                        text: "IP Address: " + root.device.ip ?? "Unknown"
                                        elide: Text.ElideRight
                                    }

                                    SIconButton{
                                        id: removeButton
                                        anchors.right: parent.right
                                        anchors.top: parent.top
                                        width: 24
                                        height: 24
                                        iconSize: height

                                        icon.source: "qrc:/icons/Resources/Icons/Material/close_white_48dp.svg"

                                        onClicked: {
                                            discovery.remove(root.device);
                                        }
                                    }
                                }

                                SButton {
                                    id: deviceLink
                                    anchors.left: deviceImage.right
                                    anchors.leftMargin: 10
                                    anchors.top: textContainer.bottom

                                    color: (root.device.paired === true) ? hovered ? Qt.darker("#394e61", 1.5) : "#394e61" : hovered ? Qt.darker("#5664b1", 1.5) : "#5664b1"

                                    label.font.pixelSize: 16
                                    label.text: (root.device.paired === true) ? "Unlink" : "Link"
                                    label.font.family: "Red Hat Display"
                                    label.font.bold: true

                                    width: Math.min(210, textContainer.width + 10)
                                    height: 32

                                    onClicked: {
                                        if(root.device.paired === true){
                                            discovery.unlink(root.device);
                                        }else {
                                            discovery.link(root.device);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    //I'll burn this down once I get a better idea of how to do it.
    //For now it'll serve its purpose.
    Rectangle{
        id: cacheBurnBox
        height: 200
        width: 520
        radius: 8
        color: theme.background2
        visible: false

        Text{
            topPadding: 16
            anchors.horizontalCenter: parent.horizontalCenter

	    	color: "White"
	    	text: "Are you sure you want to clear the cache?" 
	    	font.pixelSize: 24
	    	font.family: theme.primaryfont
            wrapMode: Text.Wrap
	    }

        SButton{
            width: 132
            x: 122
            y: 92

            color: hovered ? Qt.darker(theme.background4, 1.5) : theme.background4
            label.font.pixelSize: 24
            label.text: "Go Back"

            onClicked : {
                cacheBurnBox.visible = false
            }
        }

        SButton{
            width: 132
            x: 278
            y: 92

            color: hovered ? Qt.darker("#531B1B", 1.5) : "#531B1B"
            label.font.pixelSize: 24
            label.text: "I'm Sure"

            onClicked : {
                discovery.purgeIPCache();
                cacheBurnBox.visible = false
            }
        }
    }
}